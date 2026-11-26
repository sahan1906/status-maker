import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import {
  LandscapeTilt,
  PaceMode,
  PACE_SECONDS,
  ReelTemplate,
  TransitionChoice,
  TransitionType,
} from '../data/templates';

export type FrameImage = ImageBitmap | HTMLImageElement;
export type FrameSource = FrameImage | HTMLVideoElement;

export interface RenderClip {
  id: string;
  kind: 'photo' | 'video';
  source: FrameSource;
  poster?: FrameImage;
  trimStart: number;
  trimEnd: number;
}

export interface ClipSegment {
  index: number;
  clip: RenderClip;
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface VideoSyncTarget {
  video: HTMLVideoElement;
  targetTime: number;
  isPrimary: boolean;
}

export interface RenderConfig {
  template: ReelTemplate;
  images: FrameImage[];
  clips?: RenderClip[];
  title: string;
  subtitle: string;
  pace: PaceMode;
  landscapeTilt?: LandscapeTilt;
  transitionOverride?: TransitionChoice;
  watermarkEnabled: boolean;
  watermarkText: string;
}

export interface ExportVideoResult {
  blob: Blob;
  url: string;
  mimeType: string;
  extension: 'mp4' | 'webm';
  encoderUsed: 'webcodecs-mp4' | 'mediarecorder';
  durationSec: number;
  width: number;
  height: number;
}

interface Seed {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  phase: number;
}

const SEEDS: Seed[] = Array.from({ length: 24 }, (_, i) => {
  const n1 = Math.sin(i * 19.31 + 0.7) * 43758.5453;
  const n2 = Math.sin(i * 73.19 + 2.1) * 43758.5453;
  const n3 = Math.sin(i * 41.87 + 5.4) * 43758.5453;
  const f1 = n1 - Math.floor(n1);
  const f2 = n2 - Math.floor(n2);
  const f3 = n3 - Math.floor(n3);
  return {
    x: f1,
    y: f2,
    r: 0.4 + f3 * 0.9,
    vx: (f2 - 0.5) * 0.03,
    vy: 0.04 + f1 * 0.06,
    phase: f3 * Math.PI * 2,
  };
});

// Reusable dual offscreen compositing buffers keyed by resolution to avoid per-frame allocations
interface TransitionBuffers {
  fromCanvas: HTMLCanvasElement;
  fromCtx: CanvasRenderingContext2D;
  toCanvas: HTMLCanvasElement;
  toCtx: CanvasRenderingContext2D;
}

const bufferPool = new Map<string, TransitionBuffers>();

function getTransitionBuffers(w: number, h: number): TransitionBuffers {
  const key = `${w}x${h}`;
  const existing = bufferPool.get(key);
  if (existing) return existing;

  const fromCanvas = document.createElement('canvas');
  fromCanvas.width = w;
  fromCanvas.height = h;
  const toCanvas = document.createElement('canvas');
  toCanvas.width = w;
  toCanvas.height = h;

  const fromCtx = fromCanvas.getContext('2d')!;
  const toCtx = toCanvas.getContext('2d')!;
  const entry = { fromCanvas, fromCtx, toCanvas, toCtx };
  bufferPool.set(key, entry);
  return entry;
}

export function getEffectiveTransition(config: RenderConfig): TransitionType {
  if (config.transitionOverride && config.transitionOverride !== 'auto') {
    return config.transitionOverride;
  }
  return config.template.transition;
}

export function getSlideDuration(template: ReelTemplate, pace: PaceMode): number {
  return Math.max(0.95, Number((PACE_SECONDS[pace] * template.paceMultiplier).toFixed(2)));
}

function getNormalizedClips(config: RenderConfig): RenderClip[] {
  if (config.clips && config.clips.length > 0) {
    return config.clips;
  }
  return config.images.map((img, idx) => ({
    id: `img-${idx}`,
    kind: 'photo',
    source: img,
    trimStart: 0,
    trimEnd: 0,
  }));
}

export function getClipTimeline(config: RenderConfig): {
  introDur: number;
  segments: ClipSegment[];
  totalDuration: number;
} {
  const clips = getNormalizedClips(config);
  const slideDur = getSlideDuration(config.template, config.pace);
  const hasIntroText = Boolean(config.title.trim() || config.subtitle.trim());
  const introDur = config.template.overlay === 'kinetic-intro' && hasIntroText ? 1.0 : 0;

  let cursor = introDur;
  const segments: ClipSegment[] = clips.map((clip, index) => {
    const durationSec =
      clip.kind === 'video'
        ? Math.max(0.3, Number((clip.trimEnd - clip.trimStart).toFixed(3)))
        : slideDur;
    const startSec = cursor;
    const endSec = cursor + durationSec;
    cursor = endSec;
    return { index, clip, startSec, endSec, durationSec };
  });

  const totalDuration =
    segments.length > 0 ? Number(cursor.toFixed(2)) : Number((slideDur + introDur).toFixed(2));
  return { introDur, segments, totalDuration };
}

export function getTotalDuration(config: RenderConfig): number {
  return getClipTimeline(config).totalDuration;
}

function getTransitionDuration(
  activeTransition: TransitionType,
  curDuration: number,
  nextDuration: number
): number {
  if (activeTransition === 'none') return 0;
  const base =
    activeTransition === 'shutter-flash' || activeTransition === 'rgb-glitch' ? 0.42 : 0.62;
  return Math.min(base, curDuration * 0.36, nextDuration * 0.36);
}

export function getActiveVideoTargets(timeSec: number, config: RenderConfig): VideoSyncTarget[] {
  const { introDur, segments } = getClipTimeline(config);
  if (segments.length === 0 || timeSec < introDur) return [];

  const lastSeg = segments[segments.length - 1];
  const clampedTime = Math.max(introDur, Math.min(timeSec, lastSeg.endSec - 0.0001));

  let segIdx = segments.length - 1;
  for (let i = 0; i < segments.length; i += 1) {
    if (clampedTime < segments[i].endSec) {
      segIdx = i;
      break;
    }
  }

  const seg = segments[segIdx];
  const localTime = Math.max(0, clampedTime - seg.startSec);
  const targets: VideoSyncTarget[] = [];

  if (seg.clip.kind === 'video' && isVideoElement(seg.clip.source)) {
    const targetTime = Math.min(
      Math.max(seg.clip.trimStart, seg.clip.trimStart + localTime),
      Math.max(seg.clip.trimStart, seg.clip.trimEnd - 0.02)
    );
    targets.push({ video: seg.clip.source, targetTime, isPrimary: true });
  }

  const activeTransition = getEffectiveTransition(config);
  if (segIdx < segments.length - 1) {
    const nextSeg = segments[segIdx + 1];
    const transDur = getTransitionDuration(activeTransition, seg.durationSec, nextSeg.durationSec);
    if (transDur > 0 && localTime > seg.durationSec - transDur) {
      const tRaw = clamp01((localTime - (seg.durationSec - transDur)) / transDur);
      if (nextSeg.clip.kind === 'video' && isVideoElement(nextSeg.clip.source)) {
        const nextLocal = tRaw * Math.min(transDur, nextSeg.durationSec * 0.25);
        const targetTime = Math.min(
          Math.max(nextSeg.clip.trimStart, nextSeg.clip.trimStart + nextLocal),
          Math.max(nextSeg.clip.trimStart, nextSeg.clip.trimEnd - 0.02)
        );
        targets.push({ video: nextSeg.clip.source, targetTime, isPrimary: false });
      }
    }
  }

  return targets;
}

export function isVideoElement(src: FrameSource): src is HTMLVideoElement {
  return typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement;
}

export function seekVideoToTime(video: HTMLVideoElement, targetSec: number): Promise<void> {
  const maxDur =
    Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 0.015) : targetSec;
  const clamped = Math.max(0, Math.min(targetSec, maxDur));

  if (!video.paused) {
    try {
      video.pause();
    } catch {
      // ignore
    }
  }

  if (Math.abs(video.currentTime - clamped) < 0.008 && video.readyState >= 2) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', finish);
      resolve();
    };
    const onReady = () => {
      if (video.readyState >= 2) {
        finish();
      }
    };
    const timer = window.setTimeout(finish, 650);
    video.addEventListener('seeked', onReady);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('error', finish, { once: true });
    try {
      video.currentTime = clamped;
    } catch {
      finish();
    }
  });
}

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

function easeInExpo(t: number): number {
  const c = clamp01(t);
  return c === 0 ? 0 : Math.pow(2, 10 * (c - 1));
}

function easeOutExpo(t: number): number {
  const c = clamp01(t);
  return c === 1 ? 1 : 1 - Math.pow(2, -10 * c);
}

function easeInOutExpo(t: number): number {
  const c = clamp01(t);
  if (c === 0 || c === 1) return c;
  return c < 0.5 ? Math.pow(2, 20 * c - 10) / 2 : (2 - Math.pow(2, -20 * c + 10)) / 2;
}

function easeInOutQuart(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 8 * c * c * c * c : 1 - Math.pow(-2 * c + 2, 4) / 2;
}

function easeInOutSine(t: number): number {
  const c = clamp01(t);
  return -(Math.cos(Math.PI * c) - 1) / 2;
}

interface PhotoMeta {
  focusX: number; // 0..1
  focusY: number; // 0..1
  bgTop: string;
  bgBottom: string;
}

const DEFAULT_META: PhotoMeta = {
  focusX: 0.5,
  focusY: 0.42,
  bgTop: '#16161C',
  bgBottom: '#08080A',
};

const photoMetaCache = new WeakMap<FrameSource, PhotoMeta>();
let analysisCanvas: HTMLCanvasElement | null = null;
let analysisCtx: CanvasRenderingContext2D | null = null;

/**
 * Fast (<0.4ms, cached once per photo) client-side visual saliency + skin-tone focal detector
 * and dominant top/bottom edge palette extractor. Keeps faces/subjects centered automatically
 * and derives native Instagram-style studio background colors without ugly Gaussian blur.
 */
function analyzePhotoMeta(img: FrameSource): PhotoMeta {
  if (isVideoElement(img)) return DEFAULT_META;
  const cached = photoMetaCache.get(img);
  if (cached) return cached;

  try {
    if (!analysisCanvas) {
      analysisCanvas = document.createElement('canvas');
      analysisCanvas.width = 48;
      analysisCanvas.height = 48;
      analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!analysisCtx) {
      photoMetaCache.set(img, DEFAULT_META);
      return DEFAULT_META;
    }

    const size = 48;
    analysisCtx.clearRect(0, 0, size, size);
    analysisCtx.drawImage(img, 0, 0, size, size);
    const { data } = analysisCtx.getImageData(0, 0, size, size);

    // 1. Extract subtle dark studio colors from top & bottom strips
    let tr = 0, tg = 0, tb = 0, tc = 0;
    let br = 0, bg = 0, bb = 0, bc = 0;

    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < size; x += 2) {
        const i = (y * size + x) * 4;
        tr += data[i];
        tg += data[i + 1];
        tb += data[i + 2];
        tc += 1;

        const bi = ((size - 1 - y) * size + x) * 4;
        br += data[bi];
        bg += data[bi + 1];
        bb += data[bi + 2];
        bc += 1;
      }
    }

    const darkTone = (r: number, g: number, b: number, c: number) => {
      const rr = Math.round((r / Math.max(1, c)) * 0.34 + 6);
      const gg = Math.round((g / Math.max(1, c)) * 0.34 + 6);
      const bb2 = Math.round((b / Math.max(1, c)) * 0.34 + 8);
      return `rgb(${rr}, ${gg}, ${bb2})`;
    };

    // 2. Compute focal centroid using edge-contrast saliency + warm skin-tone + upper-center prior
    let weightSum = 0;
    let sumX = 0;
    let sumY = 0;

    for (let y = 1; y < size - 1; y += 1) {
      for (let x = 1; x < size - 1; x += 1) {
        const idx = (y * size + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;

        const idxR = (y * size + (x + 1)) * 4;
        const idxD = ((y + 1) * size + x) * 4;
        const lumR = 0.299 * data[idxR] + 0.587 * data[idxR + 1] + 0.114 * data[idxR + 2];
        const lumD = 0.299 * data[idxD] + 0.587 * data[idxD + 1] + 0.114 * data[idxD + 2];
        const edge = Math.abs(lum - lumR) + Math.abs(lum - lumD);

        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const sat = maxC > 0 ? (maxC - minC) / maxC : 0;

        // Broad natural skin-tone prior (works across diverse Indian & global skin tones)
        const isWarmFaceTone =
          r > 70 &&
          g > 35 &&
          b > 18 &&
          r > g &&
          g > b * 0.85 &&
          r - minC > 14 &&
          r - g < 95;

        const nx = x / size;
        const ny = y / size;
        // Mild rule-of-thirds upper-center preference so faces stay safely in frame
        const dx = nx - 0.5;
        const dy = ny - 0.4;
        const centerPrior = Math.exp(-(dx * dx * 3.2 + dy * dy * 4.0));

        const weight =
          (edge * 0.045 + sat * 1.4 + (isWarmFaceTone ? 3.2 : 0.25)) * (0.45 + centerPrior * 1.1);

        weightSum += weight;
        sumX += nx * weight;
        sumY += ny * weight;
      }
    }

    const focusX = weightSum > 0 ? Math.max(0.24, Math.min(0.76, sumX / weightSum)) : 0.5;
    const focusY = weightSum > 0 ? Math.max(0.24, Math.min(0.64, sumY / weightSum)) : 0.42;

    const meta: PhotoMeta = {
      focusX,
      focusY,
      bgTop: darkTone(tr, tg, tb, tc),
      bgBottom: darkTone(br, bg, bb, bc),
    };
    photoMetaCache.set(img, meta);
    return meta;
  } catch {
    photoMetaCache.set(img, DEFAULT_META);
    return DEFAULT_META;
  }
}

function getSourceDims(img: FrameSource): { iw: number; ih: number } {
  if (isVideoElement(img)) {
    return { iw: img.videoWidth || img.width || 720, ih: img.videoHeight || img.height || 1280 };
  }
  if ('naturalWidth' in img) {
    return { iw: img.naturalWidth || img.width, ih: img.naturalHeight || img.height };
  }
  return { iw: img.width, ih: img.height };
}

function drawCoverInRect(
  ctx: CanvasRenderingContext2D,
  img: FrameSource,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  zoom: number,
  panX: number,
  panY: number,
  focusX = 0.5,
  focusY = 0.46
): void {
  const { iw, ih } = getSourceDims(img);
  if (!iw || !ih) return;

  const targetRatio = rw / rh;
  const imgRatio = iw / ih;

  let drawW = rw;
  let drawH = rh;
  if (imgRatio > targetRatio) {
    drawH = rh * zoom;
    drawW = drawH * imgRatio;
  } else {
    drawW = rw * zoom;
    drawH = drawW / imgRatio;
  }

  // Anchor around detected focal subject while staying strictly within image bounds
  const overflowX = Math.max(0, drawW - rw);
  const overflowY = Math.max(0, drawH - rh);
  const baseDx = rx - overflowX * clamp01(focusX);
  const baseDy = ry - overflowY * clamp01(focusY);

  const dx = Math.max(rx - overflowX, Math.min(rx, baseDx + panX));
  const dy = Math.max(ry - overflowY, Math.min(ry, baseDy + panY));

  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  ctx.drawImage(img, dx, dy, drawW, drawH);
  ctx.restore();
}

/**
 * Draws an image covering (rx, ry, rw, rh). If the target box is portrait and the photo
 * is landscape (imgRatio >= 1.18), automatically rotates the photo 90deg left or right
 * so it fills the vertical frame cleanly without losing the wide scene.
 */
function drawAutoCoverInRect(
  ctx: CanvasRenderingContext2D,
  img: FrameSource,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  zoom: number,
  panX: number,
  panY: number,
  focusX = 0.5,
  focusY = 0.46,
  landscapeTilt: LandscapeTilt = 'right'
): void {
  const { iw, ih } = getSourceDims(img);
  if (!iw || !ih) return;

  const imgRatio = iw / ih;
  const rectRatio = rw / rh;
  const shouldRotate = imgRatio >= 1.18 && rectRatio < 0.9;

  if (!shouldRotate) {
    drawCoverInRect(ctx, img, rx, ry, rw, rh, zoom, panX, panY, focusX, focusY);
    return;
  }

  // Rotate landscape photo 90deg left (-PI/2) or right (+PI/2) around rect center
  const isLeft = landscapeTilt === 'left';
  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  ctx.translate(rx + rw / 2, ry + rh / 2);
  ctx.rotate(isLeft ? -Math.PI / 2 : Math.PI / 2);
  const localPanX = isLeft ? -panY : panY;
  const localPanY = isLeft ? panX : -panX;
  drawCoverInRect(ctx, img, -rh / 2, -rw / 2, rh, rw, zoom, localPanX, localPanY, focusX, focusY);
  ctx.restore();
}

/**
 * Automatic uniform 9:16 framing:
 * - Landscape photos (ratio >= 1.18): auto-rotate 90deg (left or right) and fill 9:16 edge-to-edge.
 * - Square-type photos (0.85 < ratio < 1.18): fit uncropped inside the frame with soft blur filling
 *   the remaining top & bottom space so the whole video feels uniform and polished.
 * - Portrait photos (ratio <= 0.85): fill 9:16 edge-to-edge with smooth subject-anchored Ken Burns.
 */
function drawAutoUniformSlide(
  ctx: CanvasRenderingContext2D,
  img: FrameSource,
  w: number,
  h: number,
  progress: number,
  slideIdx: number,
  filter: string,
  landscapeTilt: LandscapeTilt
): void {
  const { iw, ih } = getSourceDims(img);
  if (!iw || !ih) return;

  const isVid = isVideoElement(img);
  const meta = analyzePhotoMeta(img);
  const s = w / 720;
  const dir = slideIdx % 2 === 0 ? 1 : -1;
  const imgRatio = iw / ih;
  const isLandscape = imgRatio >= 1.18;
  const isSquareType = imgRatio > 0.85 && imgRatio < 1.18;

  // 1. LANDSCAPE PHOTO / VIDEO: Auto-rotate 90deg left/right and fill the 9:16 frame edge-to-edge
  if (isLandscape) {
    ctx.save();
    ctx.filter = filter;
    const zoom = isVid ? 1.0 : 1.03 + progress * 0.08;
    const driftY = isVid ? 0 : dir * (easeInOutSine(progress) - 0.5) * h * 0.035;
    const driftX = isVid ? 0 : (0.5 - progress) * w * 0.02;
    drawAutoCoverInRect(ctx, img, 0, 0, w, h, zoom, driftX, driftY, meta.focusX, meta.focusY, landscapeTilt);
    ctx.restore();
    return;
  }

  // 2. SQUARE-TYPE PHOTO / VIDEO: Fit uncropped inside frame + soft blurred backdrop
  if (isSquareType) {
    ctx.save();
    ctx.filter = 'blur(28px) brightness(0.45) saturate(1.22)';
    drawCoverInRect(ctx, img, -44 * s, -44 * s, w + 88 * s, h + 88 * s, 1.14, 0, 0, meta.focusX, meta.focusY);
    ctx.restore();

    const maxW = w * 0.94;
    const maxH = h * 0.68;
    let boxW = maxW;
    let boxH = boxW / imgRatio;
    if (boxH > maxH) {
      boxH = maxH;
      boxW = boxH * imgRatio;
    }

    const bx = (w - boxW) / 2;
    const by = (h - boxH) * 0.45;
    const radius = 16 * s;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.56)';
    ctx.shadowBlur = 40 * s;
    ctx.shadowOffsetY = 16 * s;
    ctx.fillStyle = '#0B0B0E';
    roundedRectPath(ctx, bx, by, boxW, boxH, radius);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    roundedRectPath(ctx, bx, by, boxW, boxH, radius);
    ctx.clip();
    ctx.filter = filter;
    const gentleZoom = isVid ? 1.0 : 1.0 + easeInOutSine(progress) * 0.05;
    drawCoverInRect(ctx, img, bx, by, boxW, boxH, gentleZoom, 0, 0, meta.focusX, meta.focusY);
    ctx.restore();

    ctx.save();
    roundedRectPath(ctx, bx, by, boxW, boxH, radius);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.5 * s;
    ctx.stroke();
    ctx.restore();
    return;
  }

  // 3. PORTRAIT PHOTO / VIDEO: Full-screen edge-to-edge 9:16
  ctx.save();
  ctx.filter = filter;
  const zoom = isVid ? 1.0 : 1.03 + progress * 0.085;
  const panX = isVid ? 0 : dir * (easeInOutSine(progress) - 0.5) * w * 0.04;
  const panY = isVid ? 0 : (0.5 - progress) * h * 0.018;
  drawCoverInRect(ctx, img, 0, 0, w, h, zoom, panX, panY, meta.focusX, meta.focusY);
  ctx.restore();
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function getFilterString(template: ReelTemplate, slideProgress: number): string {
  switch (template.grade) {
    case 'none':
      return 'none';
    case 'kodak-warm':
      return 'contrast(1.06) saturate(1.12) sepia(0.14)';
    case 'teal-amber':
      return 'contrast(1.14) saturate(1.08) brightness(0.95)';
    case 'clean-swiss':
      return 'contrast(1.04) saturate(0.96)';
    case 'punchy-pop':
      return 'contrast(1.15) saturate(1.22)';
    case 'soft-matte':
      return 'contrast(0.96) brightness(1.02) saturate(0.94)';
    case 'editorial-contrast':
      return 'contrast(1.18) saturate(0.92)';
    case 'golden-leak':
      return 'contrast(1.05) saturate(1.15) sepia(0.12)';
    case 'instant-film':
      return 'contrast(1.08) sepia(0.16) brightness(1.02)';
    case 'after-dark':
      return 'contrast(1.22) brightness(0.86) saturate(1.05)';
    case 'champagne-luxe':
      return 'contrast(1.05) sepia(0.1) brightness(0.98)';
    case 'dream-haze':
      return 'contrast(0.95) brightness(1.04) saturate(1.06) sepia(0.08)';
    case 'mono-bloom': {
      const gray = Math.max(0, 1 - easeOutCubic(slideProgress / 0.62));
      return `grayscale(${gray.toFixed(2)}) contrast(${(1.14 - (1 - gray) * 0.08).toFixed(2)})`;
    }
    case 'vhs-90s':
      return 'contrast(1.1) saturate(0.88) sepia(0.18)';
    case 'warm-heritage':
      return 'contrast(1.1) saturate(1.18) sepia(0.1)';
    case 'vivid-boost':
      return 'contrast(1.16) saturate(1.32)';
    default:
      return 'none';
  }
}

function drawBlurredBackdrop(
  ctx: CanvasRenderingContext2D,
  img: FrameSource,
  w: number,
  h: number
): void {
  ctx.save();
  ctx.filter = 'blur(26px) brightness(0.45) saturate(1.15)';
  drawCoverInRect(ctx, img, -36, -36, w + 72, h + 72, 1.12, 0, 0);
  ctx.restore();
}

function drawStyledSlide(
  ctx: CanvasRenderingContext2D,
  img: FrameSource,
  secondaryImg: FrameSource | null,
  w: number,
  h: number,
  progress: number,
  slideIdx: number,
  template: ReelTemplate,
  title: string,
  subtitle: string,
  landscapeTilt: LandscapeTilt
): void {
  const s = w / 720;
  const dir = slideIdx % 2 === 0 ? 1 : -1;
  const filter = getFilterString(template, progress);

  ctx.fillStyle = '#08080A';
  ctx.fillRect(0, 0, w, h);

  if (template.layout === 'boarding-card' || template.layout === 'gallery-card' || template.layout === 'glass-stage') {
    const meta = analyzePhotoMeta(img);
    drawBlurredBackdrop(ctx, img, w, h);
    const maxCardH = h * 0.72;
    const rawCardW = template.layout === 'glass-stage' ? w * 0.8 : w * 0.84;
    const targetCardH = template.layout === 'boarding-card' ? rawCardW * 1.25 : rawCardW * 1.38;
    const cardH = Math.min(targetCardH, maxCardH);
    const cardW = Math.min(rawCardW, cardH * 0.85);
    const cx = (w - cardW) / 2;
    const cy = (h - cardH) / 2 - 22 * s;
    const radius = template.layout === 'glass-stage' ? 28 * s : template.layout === 'gallery-card' ? 6 * s : 16 * s;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 44 * s;
    ctx.shadowOffsetY = 20 * s;

    if (template.layout === 'gallery-card') {
      const mat = 18 * s;
      ctx.fillStyle = '#F5F5F3';
      roundedRectPath(ctx, cx - mat, cy - mat, cardW + mat * 2, cardH + mat * 2, radius);
      ctx.fill();
    } else if (template.layout === 'glass-stage') {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundedRectPath(ctx, cx - 6 * s, cy - 6 * s, cardW + 12 * s, cardH + 12 * s, radius + 4 * s);
      ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    roundedRectPath(ctx, cx, cy, cardW, cardH, radius);
    ctx.clip();
    ctx.filter = filter;
    const zoom = 1.03 + progress * 0.08;
    drawAutoCoverInRect(
      ctx,
      img,
      cx,
      cy,
      cardW,
      cardH,
      zoom,
      dir * (progress - 0.5) * 18 * s,
      0,
      meta.focusX,
      meta.focusY,
      landscapeTilt
    );
    ctx.restore();

    if (template.layout === 'glass-stage') {
      ctx.save();
      roundedRectPath(ctx, cx, cy, cardW, cardH, radius);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2 * s;
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  if (template.layout === 'polaroid') {
    const meta = analyzePhotoMeta(img);
    drawBlurredBackdrop(ctx, img, w, h);
    const captionBand = 128 * s;
    const maxFrameH = h * 0.82;
    let frameW = w * 0.82;
    let photoW = frameW - 44 * s;
    let photoH = Math.min(photoW * 1.12, maxFrameH - captionBand - 24 * s);
    if (photoH < photoW * 0.72) {
      photoW = photoH / 0.72;
      frameW = photoW + 44 * s;
    }
    const frameH = photoH + captionBand + 24 * s;
    const fx = (w - frameW) / 2;
    const fy = (h - frameH) / 2 - 8 * s;
    const tilt = (slideIdx % 2 === 0 ? -1 : 1) * 0.022;

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(tilt);
    ctx.translate(-w / 2, -h / 2);

    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 40 * s;
    ctx.shadowOffsetY = 18 * s;
    ctx.fillStyle = '#F7F5F0';
    roundedRectPath(ctx, fx, fy, frameW, frameH, 8 * s);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.filter = filter;
    drawAutoCoverInRect(
      ctx,
      img,
      fx + 22 * s,
      fy + 24 * s,
      photoW,
      photoH,
      1.04 + progress * 0.06,
      0,
      0,
      meta.focusX,
      meta.focusY,
      landscapeTilt
    );
    ctx.filter = 'none';

    const cleanTitle = title.trim();
    const cleanSub = subtitle.trim();
    if (cleanTitle) {
      ctx.fillStyle = '#18181B';
      ctx.textAlign = 'center';
      ctx.font = `italic 600 ${Math.round(28 * s)}px "Cormorant Garamond", Georgia, serif`;
      ctx.fillText(cleanTitle.slice(0, 28), w / 2, fy + photoH + 68 * s);
    }
    if (cleanSub) {
      ctx.fillStyle = '#71717A';
      ctx.textAlign = 'center';
      ctx.font = `500 ${Math.round(14 * s)}px "JetBrains Mono", monospace`;
      ctx.fillText(cleanSub.slice(0, 28), w / 2, fy + photoH + 100 * s);
    }
    ctx.restore();
    return;
  }

  if (template.layout === 'dual-split' && secondaryImg && slideIdx % 2 === 1) {
    const m1 = analyzePhotoMeta(img);
    const m2 = analyzePhotoMeta(secondaryImg);
    ctx.fillStyle = '#09090B';
    ctx.fillRect(0, 0, w, h);
    const pad = 24 * s;
    const gap = 14 * s;
    const topY = Math.max(44 * s, h * 0.085);
    const bottomReserve = Math.max(110 * s, h * 0.16);
    const availH = h - topY - bottomReserve;
    const panelH = (availH - gap) / 2;
    const panelW = w - pad * 2;
    const zoom = 1.04 + progress * 0.07;

    ctx.save();
    ctx.filter = filter;
    roundedRectPath(ctx, pad, topY, panelW, panelH, 14 * s);
    ctx.save();
    ctx.clip();
    drawCoverInRect(ctx, img, pad, topY, panelW, panelH, zoom, (progress - 0.5) * 18 * s, 0, m1.focusX, m1.focusY);
    ctx.restore();

    roundedRectPath(ctx, pad, topY + panelH + gap, panelW, panelH, 14 * s);
    ctx.save();
    ctx.clip();
    drawCoverInRect(ctx, secondaryImg, pad, topY + panelH + gap, panelW, panelH, zoom, (0.5 - progress) * 18 * s, 0, m2.focusX, m2.focusY);
    ctx.restore();
    ctx.restore();
    return;
  }

  // Automatic uniform 9:16 framing (landscape auto-rotates left/right, square fits over blur, portrait fills)
  drawAutoUniformSlide(ctx, img, w, h, progress, slideIdx, filter, landscapeTilt);
}

/**
 * Composites two pre-rendered slides using authentic InShot Pro transition physics:
 * speed-ramp curves, directional motion-blur streaks, vortex spin unwinding,
 * RGB glitch slices, prism light-burn flares, split curtains, diagonal slashes, and 3D flips.
 */
function renderInShotTransition(
  ctx: CanvasRenderingContext2D,
  fromCanvas: HTMLCanvasElement,
  toCanvas: HTMLCanvasElement,
  w: number,
  h: number,
  t: number, // 0..1
  transition: TransitionType,
  slideIdx: number
): void {
  const s = w / 720;

  if (transition === 'hyper-zoom') {
    // InShot Pro "Zoom In / Zoom Pull": outgoing speeds into hyper-scale + blur, incoming snaps down cleanly
    const isPush = slideIdx % 2 === 0;
    if (t < 0.5) {
      const p = easeInExpo(t * 2);
      const scale = isPush ? 1 + p * 0.95 : 1 - p * 0.32;
      const blurPx = (p * 14 * s).toFixed(1);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.filter = `blur(${blurPx}px) brightness(${(1 + p * 0.25).toFixed(2)})`;
      ctx.drawImage(fromCanvas, 0, 0);
      ctx.restore();

      // Subtle motion-trail echo
      ctx.save();
      ctx.globalAlpha = p * 0.28;
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale * 1.08, scale * 1.08);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(fromCanvas, 0, 0);
      ctx.restore();
    } else {
      const p = easeOutExpo((t - 0.5) * 2);
      const scale = isPush ? 0.55 + p * 0.45 : 1.75 - p * 0.75;
      const blurPx = ((1 - p) * 14 * s).toFixed(1);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.filter = `blur(${blurPx}px) brightness(${(1 + (1 - p) * 0.22).toFixed(2)})`;
      ctx.drawImage(toCanvas, 0, 0);
      ctx.restore();
    }

    // Crisp velocity exposure bloom right at the midpoint snap
    const flash = Math.pow(Math.sin(t * Math.PI), 4) * 0.28;
    if (flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${flash.toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
    return;
  }

  if (transition === 'whip-pan' || transition === 'whip-up') {
    // InShot Pro "Whip / Swish": exponential speed-ramp pan with directional motion-blur trails
    const isHoriz = transition === 'whip-pan';
    const dir = slideIdx % 2 === 0 ? -1 : 1;
    const p = easeInOutExpo(t);
    const velocity = Math.sin(t * Math.PI); // peaks sharply at 0.5
    const blurPx = (velocity * 12 * s).toFixed(1);

    const drawWithStreak = (img: HTMLCanvasElement, ox: number, oy: number) => {
      ctx.save();
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(img, ox, oy);
      ctx.restore();

      // Directional motion echo streaks for silky optical whip feel
      if (velocity > 0.25) {
        const streakShift = velocity * 34 * s * dir;
        ctx.save();
        ctx.globalAlpha = velocity * 0.3;
        ctx.drawImage(
          img,
          ox - (isHoriz ? streakShift : 0),
          oy - (isHoriz ? 0 : streakShift)
        );
        ctx.restore();
      }
    };

    if (isHoriz) {
      const fromX = dir * p * w;
      const toX = fromX - dir * w;
      drawWithStreak(fromCanvas, fromX, 0);
      drawWithStreak(toCanvas, toX, 0);
    } else {
      const fromY = -p * h;
      const toY = fromY + h;
      drawWithStreak(fromCanvas, 0, fromY);
      drawWithStreak(toCanvas, 0, toY);
    }
    return;
  }

  if (transition === 'spin-twist') {
    // InShot Pro "Spin / Vortex Twist": accelerates into angled rotation + zoom, unwinds cleanly into next photo
    const dir = slideIdx % 2 === 0 ? 1 : -1;
    if (t < 0.5) {
      const p = easeInExpo(t * 2);
      const angle = dir * p * 0.68; // ~39 deg twist
      const scale = 1 + p * 0.55;
      const blurPx = (p * 11 * s).toFixed(1);

      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(angle);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(fromCanvas, 0, 0);
      ctx.restore();
    } else {
      const p = easeOutExpo((t - 0.5) * 2);
      const angle = -dir * (1 - p) * 0.68;
      const scale = 1.55 - p * 0.55;
      const blurPx = ((1 - p) * 11 * s).toFixed(1);

      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(angle);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(toCanvas, 0, 0);
      ctx.restore();
    }
    return;
  }

  if (transition === 'rgb-glitch') {
    // InShot Pro "Glitch": sliced horizontal displacement + cyan/magenta RGB channel split
    const intensity = Math.sin(t * Math.PI);
    const activeCanvas = t < 0.5 ? fromCanvas : toCanvas;
    const altCanvas = t < 0.5 ? toCanvas : fromCanvas;
    const jitter = Math.sin(t * 95) * intensity * 16 * s;

    ctx.drawImage(activeCanvas, jitter * 0.35, 0);

    // Chromatic aberration RGB ghost offsets
    const rgbShift = intensity * 26 * s;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = intensity * 0.55;
    ctx.drawImage(activeCanvas, -rgbShift, 0);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.28)';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(altCanvas, rgbShift, 0);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.25)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Horizontal glitch slices swapping between incoming & outgoing clips
    const sliceCount = 9;
    for (let i = 0; i < sliceCount; i += 1) {
      const hash = Math.sin(i * 43.17 + Math.floor(t * 24) * 19.7) * 43758.5453;
      const r = hash - Math.floor(hash);
      if (r < 0.45 * intensity) {
        const sy = (i / sliceCount) * h;
        const sh = (h / sliceCount) * (0.45 + r * 0.65);
        const dx = (r - 0.22) * 140 * s * intensity;
        const src = i % 2 === 0 ? altCanvas : activeCanvas;
        ctx.drawImage(src, 0, sy, w, sh, dx, sy, w, sh);
      }
    }
    return;
  }

  if (transition === 'prism-burn') {
    // InShot Pro "Light Leak / Film Burn": warm anamorphic prism wash across silky dissolve
    const p = easeInOutQuart(t);
    ctx.drawImage(fromCanvas, 0, 0);
    ctx.save();
    ctx.globalAlpha = p;
    ctx.drawImage(toCanvas, 0, 0);
    ctx.restore();

    const peak = Math.sin(t * Math.PI);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    // Diagonal sweeping golden-amber prism beam
    const cx = w * (0.15 + t * 0.7);
    const cy = h * (0.2 + t * 0.55);
    const grad = ctx.createRadialGradient(cx, cy, 10 * s, cx, cy, w * 1.15);
    grad.addColorStop(0, `rgba(255, 251, 235, ${(peak * 0.92).toFixed(3)})`);
    grad.addColorStop(0.28, `rgba(251, 146, 60, ${(peak * 0.78).toFixed(3)})`);
    grad.addColorStop(0.62, `rgba(225, 29, 72, ${(peak * 0.42).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Secondary horizontal anamorphic streak
    const streak = ctx.createLinearGradient(0, cy - 80 * s, 0, cy + 80 * s);
    streak.addColorStop(0, 'rgba(255, 255, 255, 0)');
    streak.addColorStop(0.5, `rgba(254, 240, 138, ${(peak * 0.55).toFixed(3)})`);
    streak.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = streak;
    ctx.fillRect(0, cy - 80 * s, w, 160 * s);
    ctx.restore();
    return;
  }

  if (transition === 'split-open') {
    // InShot Pro "Split Curtain": outgoing splits cleanly down the center revealing incoming zooming in
    const p = easeInOutExpo(t);
    const bgScale = 0.9 + p * 0.1;

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(bgScale, bgScale);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(toCanvas, 0, 0);
    ctx.restore();

    const halfW = w / 2;
    const offset = p * (halfW + 12 * s);

    // Left door
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 24 * s;
    ctx.drawImage(fromCanvas, 0, 0, halfW, h, -offset, 0, halfW, h);
    // Right door
    ctx.drawImage(fromCanvas, halfW, 0, halfW, h, halfW + offset, 0, halfW, h);
    ctx.restore();
    return;
  }

  if (transition === 'diagonal-slash') {
    // InShot Pro "Diagonal Wipe": angled razor mask with crisp luminous highlight seam
    const p = easeInOutExpo(t);
    ctx.drawImage(fromCanvas, 0, 0);

    const skew = w * 0.42;
    const xPos = -skew + p * (w + skew * 2);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(xPos, 0);
    ctx.lineTo(xPos - skew, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(toCanvas, 0, 0);
    ctx.restore();

    // Subtle crisp light edge along the slash seam
    const edgeAlpha = Math.sin(t * Math.PI) * 0.7;
    ctx.save();
    ctx.strokeStyle = `rgba(255, 255, 255, ${edgeAlpha.toFixed(2)})`;
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.moveTo(xPos, 0);
    ctx.lineTo(xPos - skew, h);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (transition === 'shutter-flash') {
    // InShot Pro "Flash / Strobe": crisp zoom punch into white exposure burst
    if (t < 0.48) {
      const p = easeInExpo(t / 0.48);
      const scale = 1 + p * 0.14;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(fromCanvas, 0, 0);
      ctx.restore();
    } else {
      const p = easeOutExpo((t - 0.48) / 0.52);
      const scale = 1.12 - p * 0.12;
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(toCanvas, 0, 0);
      ctx.restore();
    }

    const flashAlpha = Math.pow(Math.sin(t * Math.PI), 1.6) * 0.94;
    ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  if (transition === 'flip-3d') {
    // InShot Pro "3D Flip": foreshortened perspective pivot with realistic midpoint shading
    ctx.fillStyle = '#08080A';
    ctx.fillRect(0, 0, w, h);

    const p = easeInOutQuart(t);
    const angle = p * Math.PI;
    const isFirstHalf = p < 0.5;
    const cosVal = Math.abs(Math.cos(angle));
    const scaleX = Math.max(0.02, cosVal);
    const scaleY = 1 - (1 - cosVal) * 0.08;
    const shade = (1 - cosVal) * 0.55;

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(isFirstHalf ? fromCanvas : toCanvas, 0, 0);

    // Realistic perspective darkness as card approaches 90 deg
    ctx.fillStyle = `rgba(0, 0, 0, ${shade.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    return;
  }

  // Classic silky Cinema Dissolve
  const p = easeInOutQuart(t);
  ctx.drawImage(fromCanvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = p;
  ctx.drawImage(toCanvas, 0, 0);
  ctx.restore();
}

function drawColorGradeTint(
  ctx: CanvasRenderingContext2D,
  template: ReelTemplate,
  w: number,
  h: number,
  timeSec: number
): void {
  ctx.save();

  if (template.grade === 'teal-amber') {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, 'rgba(14, 116, 144, 0.16)');
    grad.addColorStop(1, 'rgba(217, 119, 6, 0.16)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  } else if (template.grade === 'golden-leak' || template.grade === 'kodak-warm' || template.grade === 'warm-heritage') {
    const sweep = 0.5 + 0.5 * Math.sin(timeSec * 0.9);
    const leak = ctx.createRadialGradient(w * (0.1 + sweep * 0.75), h * 0.18, 20, w * 0.5, h * 0.25, w * 0.9);
    leak.addColorStop(0, 'rgba(251, 146, 60, 0.22)');
    leak.addColorStop(0.55, 'rgba(245, 158, 11, 0.07)');
    leak.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = leak;
    ctx.fillRect(0, 0, w, h);
  } else if (template.grade === 'dream-haze') {
    const haze = ctx.createLinearGradient(0, 0, 0, h);
    haze.addColorStop(0, 'rgba(253, 186, 116, 0.14)');
    haze.addColorStop(0.5, 'rgba(244, 114, 182, 0.06)');
    haze.addColorStop(1, 'rgba(24, 16, 20, 0.28)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, w, h);
  } else if (template.grade === 'after-dark') {
    const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.22, w / 2, h / 2, h * 0.65);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(5,5,10,0.68)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  } else if (template.grade === 'vhs-90s') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.09)';
    const step = Math.max(4, Math.round(h / 180));
    for (let y = 0; y < h; y += step) {
      ctx.fillRect(0, y, w, 1.5);
    }
  }

  ctx.restore();
}

function drawFilmGrain(ctx: CanvasRenderingContext2D, w: number, h: number, timeSec: number): void {
  const frameSeed = Math.floor(timeSec * 18);
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
  for (let i = 0; i < 95; i += 1) {
    const rx = Math.sin(i * 12.9898 + frameSeed * 7.13) * 43758.5453;
    const ry = Math.sin(i * 78.233 + frameSeed * 3.71) * 43758.5453;
    const x = (rx - Math.floor(rx)) * w;
    const y = (ry - Math.floor(ry)) * h;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.restore();
}

function drawBokehOrEmbers(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  timeSec: number,
  mode: 'bokeh' | 'embers'
): void {
  const s = w / 720;
  ctx.save();
  for (const p of SEEDS) {
    const rawY = 1 - ((p.y + timeSec * p.vy) % 1.15) + 0.07;
    const rawX = (p.x + Math.sin(timeSec * 0.9 + p.phase) * 0.03 + 1) % 1;
    const px = rawX * w;
    const py = rawY * h;

    if (mode === 'bokeh') {
      const r = (22 + p.r * 38) * s;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(253, 224, 71, 0.24)');
      g.addColorStop(0.6, 'rgba(251, 146, 60, 0.08)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const pulse = 0.4 + 0.6 * Math.sin(timeSec * 3.6 + p.phase);
      const r = (2.2 + p.r * 3.4) * s;
      ctx.globalAlpha = pulse * 0.85;
      ctx.fillStyle = '#FDE68A';
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawTemplateOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  timeSec: number,
  config: RenderConfig
): void {
  const { template, title, subtitle, watermarkEnabled, watermarkText } = config;
  const s = w / 720;
  const cleanTitle = title.trim();
  const cleanSub = subtitle.trim();
  const entrance = easeOutCubic(Math.min(1, timeSec / 0.75));

  if (template.layout === 'letterbox') {
    const barH = h * 0.145;
    ctx.fillStyle = '#050506';
    ctx.fillRect(0, 0, w, barH);
    ctx.fillRect(0, h - barH, w, barH);
  } else if (template.layout === 'champagne-hairline' || template.layout === 'heritage-frame') {
    const pad = 34 * s;
    ctx.save();
    ctx.strokeStyle =
      template.layout === 'heritage-frame'
        ? 'rgba(231, 200, 139, 0.55)'
        : 'rgba(231, 200, 139, 0.45)';
    ctx.lineWidth = 1.6 * s;
    ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
    ctx.restore();
  }

  if (template.overlay === 'amber-leak-bokeh' || template.overlay === 'evening-bokeh') {
    drawBokehOrEmbers(ctx, w, h, timeSec, 'bokeh');
  } else if (template.overlay === 'warm-embers') {
    drawBokehOrEmbers(ctx, w, h, timeSec, 'embers');
  } else if (template.overlay === 'film-grain-date' || template.grade === 'vhs-90s') {
    drawFilmGrain(ctx, w, h, timeSec);
  }

  if (
    template.layout !== 'polaroid' &&
    template.layout !== 'letterbox' &&
    (cleanTitle || cleanSub)
  ) {
    const scrim = ctx.createLinearGradient(0, h * 0.62, 0, h);
    scrim.addColorStop(0, 'rgba(0,0,0,0)');
    scrim.addColorStop(1, 'rgba(6,6,9,0.78)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, h * 0.62, w, h * 0.38);
  }

  ctx.save();
  ctx.globalAlpha = entrance;

  if (template.overlay === 'film-grain-date') {
    if (cleanSub) {
      ctx.textAlign = 'right';
      ctx.font = `600 ${Math.round(22 * s)}px "JetBrains Mono", monospace`;
      ctx.fillStyle = '#FB923C';
      ctx.shadowColor = 'rgba(234, 88, 12, 0.75)';
      ctx.shadowBlur = 10 * s;
      ctx.fillText(cleanSub.toUpperCase(), w - 44 * s, h - 56 * s);
    }

    if (cleanTitle) {
      ctx.textAlign = 'left';
      ctx.shadowBlur = 8 * s;
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = `600 ${Math.round(28 * s)}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillText(cleanTitle, 44 * s, h - 56 * s);
    }
  } else if (template.overlay === 'camcorder-rec') {
    const blink = Math.floor(timeSec * 2) % 2 === 0;
    const topY = 66 * s;
    if (blink) {
      ctx.fillStyle = '#EF4444';
      ctx.beginPath();
      ctx.arc(52 * s, topY, 9 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(22 * s)}px "JetBrains Mono", monospace`;
    ctx.fillText('REC', 72 * s, topY + 7 * s);

    const mins = String(Math.floor(timeSec / 60)).padStart(2, '0');
    const secs = String(Math.floor(timeSec % 60)).padStart(2, '0');
    const frames = String(Math.floor((timeSec % 1) * 30)).padStart(2, '0');
    ctx.textAlign = 'right';
    ctx.fillText(`00:${mins}:${secs}:${frames}`, w - 44 * s, topY + 7 * s);

    if (cleanTitle || cleanSub) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `500 ${Math.round(24 * s)}px "JetBrains Mono", monospace`;
      ctx.fillText((cleanTitle || cleanSub).toUpperCase(), 44 * s, h - 58 * s);
    }
  } else if (template.overlay === 'magazine-masthead') {
    if (cleanTitle) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 16 * s;
      ctx.font = `700 ${Math.round(58 * s)}px "Cormorant Garamond", Georgia, serif`;
      ctx.fillText(cleanTitle.toUpperCase(), w / 2, 130 * s);
    }

    if (cleanSub) {
      ctx.textAlign = 'center';
      ctx.font = `500 ${Math.round(17 * s)}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(cleanSub.toUpperCase(), w / 2, h - 72 * s);
    }
  } else if (template.overlay === 'swiss-tag') {
    if (cleanTitle || cleanSub) {
      const baseY = h - 105 * s;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(54 * s, baseY - 26 * s);
      ctx.lineTo(w - 54 * s, baseY - 26 * s);
      ctx.stroke();

      if (cleanTitle) {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `600 ${Math.round(28 * s)}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(cleanTitle.toUpperCase(), 54 * s, baseY + 14 * s);
      }

      if (cleanSub) {
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(228,228,231,0.78)';
        ctx.font = `500 ${Math.round(16 * s)}px "JetBrains Mono", monospace`;
        ctx.fillText(cleanSub.toUpperCase(), w - 54 * s, baseY + 12 * s);
      }
    }
  } else if (template.overlay === 'neon-edge') {
    const pad = 28 * s;
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.55)';
    ctx.lineWidth = 2 * s;
    ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);

    if (cleanTitle || cleanSub) {
      ctx.textAlign = 'center';
      if (cleanTitle) {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `700 ${Math.round(38 * s)}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(cleanTitle.toUpperCase(), w / 2, h - 120 * s);
      }
      if (cleanSub) {
        ctx.fillStyle = '#C4B5FD';
        ctx.font = `500 ${Math.round(17 * s)}px "JetBrains Mono", monospace`;
        ctx.fillText(cleanSub.toUpperCase(), w / 2, h - 78 * s);
      }
    }
  } else if (template.overlay === 'frosted-pill') {
    if (cleanTitle || cleanSub) {
      const boxW = Math.min(w - 96 * s, 460 * s);
      const boxH = cleanTitle && cleanSub ? 104 * s : 68 * s;
      const bx = (w - boxW) / 2;
      const by = h - boxH - 64 * s;

      roundedRectPath(ctx, bx, by, boxW, boxH, 20 * s);
      ctx.fillStyle = 'rgba(12, 12, 16, 0.52)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1.5 * s;
      ctx.stroke();

      ctx.textAlign = 'center';
      if (cleanTitle) {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `600 ${Math.round(28 * s)}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(cleanTitle, w / 2, by + 42 * s);
      }
      if (cleanSub) {
        ctx.fillStyle = 'rgba(244, 244, 245, 0.78)';
        ctx.font = `400 ${Math.round(18 * s)}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(cleanSub, w / 2, by + (cleanTitle ? 76 : 42) * s);
      }
    }
  } else if (
    template.overlay === 'serif-luxe' ||
    template.overlay === 'heritage-card' ||
    template.overlay === 'gold-rule' ||
    template.overlay === 'amber-leak-bokeh' ||
    template.overlay === 'warm-embers' ||
    template.overlay === 'evening-bokeh'
  ) {
    if (cleanTitle || cleanSub) {
      const yBase = h - 135 * s;
      ctx.textAlign = 'center';

      if (template.overlay === 'gold-rule' || template.overlay === 'heritage-card') {
        ctx.fillStyle = template.accentColor;
        ctx.fillRect(w / 2 - 36 * s, yBase - 46 * s, 72 * s, 2.5 * s);
      }

      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 14 * s;
      ctx.font = `600 ${Math.round(48 * s)}px "Cormorant Garamond", Georgia, serif`;
      ctx.fillText(cleanTitle, w / 2, yBase);

      if (cleanSub) {
        ctx.shadowBlur = 8 * s;
        ctx.fillStyle = 'rgba(244, 244, 245, 0.84)';
        ctx.font = `500 ${Math.round(18 * s)}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(cleanSub, w / 2, yBase + 42 * s);
      }
    }
  } else if (
    template.overlay === 'cinema-sub' ||
    template.overlay === 'flash-beat' ||
    template.overlay === 'none' ||
    template.overlay === 'kinetic-intro'
  ) {
    if (cleanTitle || cleanSub) {
      const yPos = template.layout === 'letterbox' ? h - h * 0.072 : h - 108 * s;
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = 12 * s;
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `600 ${Math.round(32 * s)}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillText(cleanTitle, w / 2, yPos);

      if (cleanSub) {
        ctx.fillStyle = 'rgba(228,228,231,0.78)';
        ctx.font = `500 ${Math.round(16 * s)}px "JetBrains Mono", monospace`;
        ctx.fillText(cleanSub.toUpperCase(), w / 2, yPos + 34 * s);
      }
    }
  }

  ctx.restore();

  if (watermarkEnabled && watermarkText.trim()) {
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = `500 ${Math.round(16 * s)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.56)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 6 * s;
    const wmY = template.layout === 'letterbox' ? 32 * s : 42 * s;
    ctx.fillText(watermarkText.trim(), w - 38 * s, wmY);
    ctx.restore();
  }
}

function resolveDrawable(clip: RenderClip | undefined): FrameSource | null {
  if (!clip) return null;
  if (isVideoElement(clip.source)) {
    if (clip.source.readyState >= 2 && clip.source.videoWidth > 0) {
      return clip.source;
    }
    return clip.poster ?? null;
  }
  return clip.source;
}

/**
 * Unified deterministic frame renderer shared by BOTH live preview AND client-side MP4 export.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  timeSec: number,
  config: RenderConfig
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const { template, title, subtitle } = config;
  const s = w / 720;

  ctx.fillStyle = '#08080A';
  ctx.fillRect(0, 0, w, h);

  const { introDur, segments } = getClipTimeline(config);
  if (segments.length === 0) return;

  if (introDur > 0 && timeSec < introDur) {
    const p = easeOutCubic(timeSec / introDur);
    ctx.fillStyle = '#08080A';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    const scale = 0.88 + p * 0.14;
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    if (title.trim()) {
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `700 ${Math.round(78 * s)}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillText(title.trim().toUpperCase(), 0, -10 * s);
    }
    if (subtitle.trim()) {
      ctx.fillStyle = 'rgba(228,228,231,0.65)';
      ctx.font = `500 ${Math.round(20 * s)}px "JetBrains Mono", monospace`;
      ctx.fillText(subtitle.trim().toUpperCase(), 0, 44 * s);
    }
    ctx.restore();
    return;
  }

  const lastSeg = segments[segments.length - 1];
  const clampedTime = Math.max(introDur, Math.min(timeSec, lastSeg.endSec - 0.0001));

  let slideIdx = segments.length - 1;
  for (let i = 0; i < segments.length; i += 1) {
    if (clampedTime < segments[i].endSec) {
      slideIdx = i;
      break;
    }
  }

  const count = segments.length;
  const seg = segments[slideIdx];
  const nextIdx = (slideIdx + 1) % count;
  const nextSeg = segments[nextIdx];
  const localTime = Math.max(0, clampedTime - seg.startSec);
  const slideProgress = clamp01(localTime / seg.durationSec);

  const activeTransition = getEffectiveTransition(config);
  const transDur =
    count > 1 && slideIdx < count - 1
      ? getTransitionDuration(activeTransition, seg.durationSec, nextSeg.durationSec)
      : 0;

  const inTransition =
    transDur > 0 && count > 1 && slideIdx < count - 1 && localTime > seg.durationSec - transDur;

  const curImg = resolveDrawable(seg.clip);
  if (!curImg) return;
  const partnerImg = resolveDrawable(segments[(slideIdx + 1) % count].clip);
  const landscapeTilt: LandscapeTilt = config.landscapeTilt ?? 'right';

  if (inTransition) {
    const tRaw = clamp01((localTime - (seg.durationSec - transDur)) / transDur);
    const nextImg = resolveDrawable(nextSeg.clip) ?? curImg;
    const nextPartner = resolveDrawable(segments[(nextIdx + 1) % count].clip);

    const { fromCanvas, fromCtx, toCanvas, toCtx } = getTransitionBuffers(w, h);
    drawStyledSlide(fromCtx, curImg, partnerImg, w, h, slideProgress, slideIdx, template, title, subtitle, landscapeTilt);
    drawStyledSlide(toCtx, nextImg, nextPartner, w, h, tRaw * 0.15, nextIdx, template, title, subtitle, landscapeTilt);

    renderInShotTransition(ctx, fromCanvas, toCanvas, w, h, tRaw, activeTransition, slideIdx);
  } else {
    drawStyledSlide(ctx, curImg, partnerImg, w, h, slideProgress, slideIdx, template, title, subtitle, landscapeTilt);
  }

  drawColorGradeTint(ctx, template, w, h, timeSec);
  drawTemplateOverlay(ctx, w, h, timeSec, config);
}

const MAX_BITMAP_EDGE = 1440;

async function downscaleBitmapIfNeeded(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const maxDim = Math.max(bitmap.width, bitmap.height);
  if (maxDim <= MAX_BITMAP_EDGE) return bitmap;

  const scale = MAX_BITMAP_EDGE / maxDim;
  const targetW = Math.max(1, Math.round(bitmap.width * scale));
  const targetH = Math.max(1, Math.round(bitmap.height * scale));
  try {
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: targetW,
      resizeHeight: targetH,
      resizeQuality: 'high',
    });
    bitmap.close();
    return resized;
  } catch {
    return bitmap;
  }
}

/**
 * Decodes an uploaded File or image URL with automatic EXIF orientation handling via createImageBitmap.
 * Downscales large camera photos (>1440px) so up to 50 photos stay lightweight in mobile RAM.
 */
export async function loadOrientedImage(source: File | string): Promise<FrameImage> {
  if (typeof source !== 'string' && typeof createImageBitmap === 'function') {
    try {
      const raw = await createImageBitmap(source, { imageOrientation: 'from-image' });
      return await downscaleBitmapIfNeeded(raw);
    } catch {
      // Fallback to Image element below
    }
  }

  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to load image'));
      el.src = url;
    });

    if (typeof createImageBitmap === 'function') {
      try {
        const raw = await createImageBitmap(img);
        return await downscaleBitmapIfNeeded(raw);
      } catch {
        return img;
      }
    }
    return img;
  } finally {
    if (typeof source !== 'string') {
      URL.revokeObjectURL(url);
    }
  }
}

export interface LoadedVideoAsset {
  videoUrl: string;
  duration: number;
  width: number;
  height: number;
  posterUrl: string;
}

/**
 * Loads a user-picked video File, extracts its duration & dimensions, and captures a first-frame poster.
 */
export async function loadVideoAsset(file: File): Promise<LoadedVideoAsset> {
  const videoUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = videoUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Video load timed out')), 12000);
      const onLoaded = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const onError = () => {
        window.clearTimeout(timer);
        reject(new Error('Could not decode this video format on this device.'));
      };
      video.addEventListener('loadeddata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.load();
    });

    const duration =
      Number.isFinite(video.duration) && video.duration > 0.3
        ? Number(video.duration.toFixed(2))
        : 5.0;
    const width = video.videoWidth || 720;
    const height = video.videoHeight || 1280;

    // Seek briefly into the video to avoid pure-black opening fade frame
    await seekVideoToTime(video, Math.min(0.18, duration * 0.1));

    const thumbW = 240;
    const thumbH = Math.max(120, Math.round((thumbW * height) / Math.max(1, width)));
    const canvas = document.createElement('canvas');
    canvas.width = thumbW;
    canvas.height = thumbH;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, thumbW, thumbH);
    }
    const posterUrl = canvas.toDataURL('image/jpeg', 0.8);

    video.pause();
    video.removeAttribute('src');
    video.load();

    return { videoUrl, duration, width, height, posterUrl };
  } catch (err) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(videoUrl);
    throw err;
  }
}

/**
 * Creates a dedicated muted, inline HTMLVideoElement ready for frame-accurate preview & MP4 export.
 */
export async function createClipVideoElement(videoUrl: string, initialTimeSec = 0): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = videoUrl;

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(), 8000);
    const onReady = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const onError = () => {
      window.clearTimeout(timer);
      reject(new Error('Failed to prepare video clip'));
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.load();
  });

  if (initialTimeSec > 0) {
    await seekVideoToTime(video, initialTimeSec);
  }
  return video;
}

function getAdaptiveVideoBitrate(durationSec: number): number {
  // Keep 720x1280 H.264 crisp (4.2 Mbps for normal reels) while scaling gracefully
  // for long 20–50 photo edits so the exported MP4 fits inside Telegram's 19.5 MB download limit.
  const targetBudgetBits = 16.5 * 8 * 1024 * 1024;
  const calculated = targetBudgetBits / Math.max(1, durationSec);
  return Math.round(Math.max(1_100_000, Math.min(4_200_000, calculated)));
}

async function canUseWebCodecsH264(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return false;
  }
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: 'avc1.42001f',
      width,
      height,
      bitrate: 4_000_000,
      framerate: 30,
      avc: { format: 'avc' },
    });
    return Boolean(support.supported);
  } catch {
    return false;
  }
}

async function exportViaWebCodecsMp4(
  config: RenderConfig,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<ExportVideoResult> {
  const width = 720;
  const height = 1280;
  const fps = 30;
  const durationSec = getTotalDuration(config);
  const totalFrames = Math.max(30, Math.round(durationSec * fps));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width,
      height,
    },
    fastStart: 'in-memory',
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error('H.264 encoder error');
    },
  });

  const bitrate = getAdaptiveVideoBitrate(durationSec);

  encoder.configure({
    codec: 'avc1.42001f',
    width,
    height,
    bitrate,
    framerate: fps,
    avc: { format: 'avc' },
  });

  const frameDurationUs = Math.round(1_000_000 / fps);

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx += 1) {
    if (signal?.aborted) {
      encoder.close();
      throw new Error('Export cancelled');
    }
    if (encoderError) {
      encoder.close();
      throw encoderError;
    }

    while (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 8));
    }

    const timeSec = frameIdx / fps;
    const videoTargets = getActiveVideoTargets(timeSec, config);
    if (videoTargets.length > 0) {
      await Promise.all(videoTargets.map((t) => seekVideoToTime(t.video, t.targetTime)));
    }
    renderFrame(ctx, timeSec, config);

    const videoFrame = new VideoFrame(canvas, {
      timestamp: frameIdx * frameDurationUs,
      duration: frameDurationUs,
    });

    const isKeyFrame = frameIdx % (fps * 2) === 0;
    encoder.encode(videoFrame, { keyFrame: isKeyFrame });
    videoFrame.close();

    if (frameIdx % 4 === 0 || frameIdx === totalFrames - 1) {
      onProgress(Math.min(96, Math.round(((frameIdx + 1) / totalFrames) * 96)));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  onProgress(100);

  return {
    blob,
    url,
    mimeType: 'video/mp4',
    extension: 'mp4',
    encoderUsed: 'webcodecs-mp4',
    durationSec,
    width,
    height,
  };
}

async function exportViaMediaRecorder(
  config: RenderConfig,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<ExportVideoResult> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser does not support video export.');
  }

  const width = 720;
  const height = 1280;
  const durationSec = getTotalDuration(config);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');

  renderFrame(ctx, 0, config);
  const stream = canvas.captureStream(30);

  const mimeCandidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const chosenMime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const recorder = new MediaRecorder(stream, {
    videoBitsPerSecond: getAdaptiveVideoBitrate(durationSec),
    ...(chosenMime ? { mimeType: chosenMime } : {}),
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  };

  return new Promise<ExportVideoResult>((resolve, reject) => {
    let raf = 0;
    let done = false;

    const cleanup = () => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
    };

    const onAbort = () => {
      if (done) return;
      done = true;
      if (recorder.state !== 'inactive') recorder.stop();
      cleanup();
      reject(new Error('Export cancelled'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    recorder.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('Fallback video encoder failed.'));
    };

    recorder.onstop = () => {
      if (done) return;
      done = true;
      cleanup();
      const mimeType = chosenMime || recorder.mimeType || 'video/mp4';
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      onProgress(100);
      resolve({
        blob,
        url,
        mimeType,
        extension: mimeType.includes('mp4') ? 'mp4' : 'webm',
        encoderUsed: 'mediarecorder',
        durationSec,
        width,
        height,
      });
    };

    recorder.start(200);
    const startMs = performance.now();

    const syncMediaRecorderVideos = (elapsed: number) => {
      const targets = getActiveVideoTargets(elapsed, config);
      const activeSet = new Set(targets.map((t) => t.video));
      if (config.clips) {
        for (const c of config.clips) {
          if (c.kind === 'video' && isVideoElement(c.source) && !activeSet.has(c.source)) {
            if (!c.source.paused) c.source.pause();
          }
        }
      }
      for (const t of targets) {
        if (Math.abs(t.video.currentTime - t.targetTime) > 0.25) {
          try {
            t.video.currentTime = t.targetTime;
          } catch {
            // ignore
          }
        }
        if (t.video.paused) {
          void t.video.play().catch(() => {});
        }
      }
    };

    const stopAllRecorderVideos = () => {
      if (!config.clips) return;
      for (const c of config.clips) {
        if (c.kind === 'video' && isVideoElement(c.source) && !c.source.paused) {
          c.source.pause();
        }
      }
    };

    const step = (now: number) => {
      if (done) return;
      const elapsed = (now - startMs) / 1000;
      onProgress(Math.min(99, Math.round((elapsed / durationSec) * 100)));
      if (elapsed >= durationSec) {
        stopAllRecorderVideos();
        renderFrame(ctx, durationSec - 0.01, config);
        if (recorder.state !== 'inactive') recorder.stop();
        return;
      }
      syncMediaRecorderVideos(elapsed);
      renderFrame(ctx, elapsed, config);
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
  });
}

export async function exportReelMp4(options: {
  config: RenderConfig;
  onProgress: (pct: number) => void;
  signal?: AbortSignal;
}): Promise<ExportVideoResult> {
  const { config, onProgress, signal } = options;
  const webCodecsOk = await canUseWebCodecsH264(720, 1280);
  if (webCodecsOk) {
    try {
      return await exportViaWebCodecsMp4(config, onProgress, signal);
    } catch (err) {
      if (err instanceof Error && err.message === 'Export cancelled') {
        throw err;
      }
    }
  }

  return exportViaMediaRecorder(config, onProgress, signal);
}
