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
  chromaSensitivity?: number; // 0.15..0.95, default 0.55
  presetOverlayClip?: RenderClip | null;
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

// Reusable offscreen compositing buffers keyed by resolution to avoid per-frame allocations
interface TransitionBuffers {
  fromCanvas: HTMLCanvasElement;
  fromCtx: CanvasRenderingContext2D;
  toCanvas: HTMLCanvasElement;
  toCtx: CanvasRenderingContext2D;
  maskCanvas: HTMLCanvasElement;
  maskCtx: CanvasRenderingContext2D;
  chromaCanvas: HTMLCanvasElement;
  chromaCtx: CanvasRenderingContext2D;
  chromaW: number;
  chromaH: number;
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
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;

  const chromaW = Math.min(w, 480);
  const chromaH = Math.max(1, Math.round((chromaW * h) / Math.max(1, w)));
  const chromaCanvas = document.createElement('canvas');
  chromaCanvas.width = chromaW;
  chromaCanvas.height = chromaH;

  const fromCtx = fromCanvas.getContext('2d')!;
  const toCtx = toCanvas.getContext('2d')!;
  const maskCtx = maskCanvas.getContext('2d')!;
  const chromaCtx = chromaCanvas.getContext('2d', { willReadFrequently: true })!;
  const entry = {
    fromCanvas,
    fromCtx,
    toCanvas,
    toCtx,
    maskCanvas,
    maskCtx,
    chromaCanvas,
    chromaCtx,
    chromaW,
    chromaH,
  };
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

function splitChromaClips(
  clips: RenderClip[],
  presetOverlayClip?: RenderClip | null
): {
  fgClip: RenderClip | null;
  bgClips: RenderClip[];
} {
  if (presetOverlayClip) {
    return {
      fgClip: presetOverlayClip,
      bgClips: clips.length > 0 ? clips : [presetOverlayClip],
    };
  }
  const videoFg = clips.find((c) => c.kind === 'video') ?? null;
  if (!videoFg) {
    return { fgClip: null, bgClips: clips };
  }
  const others = clips.filter((c) => c.id !== videoFg.id);
  return {
    fgClip: videoFg,
    bgClips: others.length > 0 ? others : [videoFg],
  };
}

export function getClipTimeline(config: RenderConfig): {
  introDur: number;
  segments: ClipSegment[];
  totalDuration: number;
} {
  const clips = getNormalizedClips(config);
  const slideDur = getSlideDuration(config.template, config.pace);
  const special = config.template.specialMode ?? 'none';

  // Green Screen / Premade AI Overlay mode: total duration follows the foreground green-screen video's trimmed length
  if (special === 'chroma-green-screen') {
    const { fgClip } = splitChromaClips(clips, config.presetOverlayClip);
    if (fgClip && fgClip.kind === 'video') {
      const fgDur = Math.max(0.3, Number((fgClip.trimEnd - fgClip.trimStart).toFixed(3)));
      return {
        introDur: 0,
        segments: [{ index: 0, clip: fgClip, startSec: 0, endSec: fgDur, durationSec: fgDur }],
        totalDuration: Number(fgDur.toFixed(2)),
      };
    }
  }

  const hasTitle = Boolean(config.title.trim());
  const hasIntroText = Boolean(hasTitle || config.subtitle.trim());
  const introDur =
    special === 'india-train-map'
      ? 3.55
      : special === 'map-route-zoom'
      ? 3.35
      : (special === 'marvel-intro' || special === 'text-portal') && hasTitle
      ? 3.15
      : config.template.overlay === 'kinetic-intro' && hasIntroText
      ? 1.0
      : 0;

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
    activeTransition === 'flash-cut'
      ? 0.24
      : activeTransition === 'shutter-flash' ||
        activeTransition === 'rgb-glitch' ||
        activeTransition === 'zoom-shake' ||
        activeTransition === 'blur-whip'
      ? 0.38
      : 0.56;
  return Math.min(base, curDuration * 0.36, nextDuration * 0.36);
}

export function getActiveVideoTargets(timeSec: number, config: RenderConfig): VideoSyncTarget[] {
  const special = config.template.specialMode ?? 'none';

  // Green Screen / Premade AI Overlay mode: sync BOTH the foreground green-screen video AND any background video clip
  if (special === 'chroma-green-screen') {
    const allClips = getNormalizedClips(config);
    const { fgClip, bgClips } = splitChromaClips(allClips, config.presetOverlayClip);
    const targets: VideoSyncTarget[] = [];

    if (fgClip && fgClip.kind === 'video' && isVideoElement(fgClip.source)) {
      const fgDur = Math.max(0.3, fgClip.trimEnd - fgClip.trimStart);
      const local = Math.max(0, Math.min(timeSec, fgDur - 0.02));
      targets.push({
        video: fgClip.source,
        targetTime: fgClip.trimStart + local,
        isPrimary: true,
      });

      // Also sync any background video clip currently showing inside the keyed screen
      const slideDur = getSlideDuration(config.template, config.pace);
      let bgTotal = 0;
      const bgSegs = bgClips.map((c) => {
        const d = c.kind === 'video' ? Math.max(0.3, c.trimEnd - c.trimStart) : slideDur;
        const s = bgTotal;
        bgTotal += d;
        return { clip: c, start: s, end: bgTotal, dur: d };
      });
      if (bgTotal > 0) {
        const looped = timeSec % bgTotal;
        const activeBg = bgSegs.find((s) => looped < s.end) ?? bgSegs[0];
        if (
          activeBg &&
          activeBg.clip.kind === 'video' &&
          isVideoElement(activeBg.clip.source) &&
          activeBg.clip.source !== fgClip.source
        ) {
          const tLocal = Math.max(0, Math.min(looped - activeBg.start, activeBg.dur - 0.02));
          targets.push({
            video: activeBg.clip.source,
            targetTime: activeBg.clip.trimStart + tLocal,
            isPrimary: false,
          });
        }
      }
      return targets;
    }
  }

  const { introDur, segments } = getClipTimeline(config);
  if (segments.length === 0) return [];

  // During Marvel / Text Portal / Map Route intro, keep Clip #0 video poised at its trimStart (or playing smoothly)
  if (timeSec < introDur) {
    const firstClip = segments[0]?.clip;
    if (firstClip && firstClip.kind === 'video' && isVideoElement(firstClip.source)) {
      const dur = Math.max(0.3, firstClip.trimEnd - firstClip.trimStart);
      const offset =
        special === 'text-portal' ? Math.min(timeSec * 0.55, dur - 0.02) : 0;
      return [{ video: firstClip.source, targetTime: firstClip.trimStart + offset, isPrimary: true }];
    }
    return [];
  }

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

function getBaseGradeFilter(template: ReelTemplate, slideProgress: number): string {
  switch (template.grade) {
    case 'none':
      return '';
    case 'phonk-dark':
      return 'contrast(1.34) saturate(1.18) brightness(0.84)';
    case 'hdr-chrome':
      return 'contrast(1.28) saturate(1.16) brightness(0.98)';
    case 'euphoria-night':
      return 'contrast(1.14) saturate(1.22) brightness(0.92)';
    case 'flash-night':
      return 'contrast(1.24) saturate(1.06) brightness(1.06)';
    case 'cyber-glitch':
      return 'contrast(1.22) saturate(1.36) hue-rotate(-6deg)';
    case 'kodak-warm':
      return 'contrast(1.06) saturate(1.12) sepia(0.14)';
    case 'teal-amber':
      return 'contrast(1.14) saturate(1.08) brightness(0.95)';
    case 'clean-swiss':
      return 'contrast(1.04) saturate(0.96)';
    case 'punchy-pop':
      return 'contrast(1.18) saturate(1.26)';
    case 'soft-matte':
      return 'contrast(0.96) brightness(1.02) saturate(0.94)';
    case 'editorial-contrast':
      return 'contrast(1.2) saturate(0.98)';
    case 'golden-leak':
      return 'contrast(1.05) saturate(1.15) sepia(0.12)';
    case 'instant-film':
      return 'contrast(1.08) sepia(0.16) brightness(1.02)';
    case 'after-dark':
      return 'contrast(1.22) brightness(0.86) saturate(1.05)';
    case 'champagne-luxe':
      return 'contrast(1.05) sepia(0.1) brightness(0.98)';
    case 'dream-haze':
      return 'contrast(0.97) brightness(1.05) saturate(1.08) sepia(0.06)';
    case 'mono-bloom': {
      const gray = Math.max(0, 1 - easeOutCubic(slideProgress / 0.62));
      return `grayscale(${gray.toFixed(2)}) contrast(${(1.14 - (1 - gray) * 0.08).toFixed(2)})`;
    }
    case 'vhs-90s':
      return 'contrast(1.12) saturate(0.86) sepia(0.16)';
    case 'warm-heritage':
      return 'contrast(1.1) saturate(1.18) sepia(0.1)';
    case 'vivid-boost':
      return 'contrast(1.2) saturate(1.36)';
    default:
      return '';
  }
}

function getFilterString(template: ReelTemplate, slideProgress: number, w = 720): string {
  const parts: string[] = [];
  const base = getBaseGradeFilter(template, slideProgress);
  if (base) parts.push(base);

  const s = w / 720;
  const motion = template.motionStyle ?? 'none';

  if (motion === 'blur-focus-pull') {
    // Viral CapCut lens-blur focus pull: starts dreamy out-of-focus and snaps sharp
    const blurAmt = Math.max(0, 1 - easeOutCubic(slideProgress / 0.42)) * 16 * s;
    if (blurAmt > 0.25) {
      parts.push(`blur(${blurAmt.toFixed(1)}px)`);
    }
  } else if (motion === 'bw-flash-drop') {
    // High-contrast monochrome snap-dropping into vivid color on beat
    if (slideProgress < 0.36) {
      parts.push('grayscale(1) contrast(1.22)');
    } else {
      const dropBoost = Math.exp(-(slideProgress - 0.36) * 14) * 0.45;
      parts.push(`saturate(${(1.22 + dropBoost * 0.4).toFixed(2)}) brightness(${(1 + dropBoost).toFixed(2)})`);
    }
  } else if (motion === 'strobe-flash') {
    const flash = Math.exp(-slideProgress * 15) * 0.55;
    if (flash > 0.02) {
      parts.push(`brightness(${(1 + flash).toFixed(2)})`);
    }
  } else if (motion === 'velocity-pump' || motion === 'anime-impact') {
    const beatHit = Math.exp(-((slideProgress * 2) % 1) * 10) * 0.22;
    if (beatHit > 0.02) {
      parts.push(`brightness(${(1 + beatHit).toFixed(2)})`);
    }
  }

  return parts.length > 0 ? parts.join(' ') : 'none';
}

function getCameraMotionTransform(
  template: ReelTemplate,
  progress: number,
  slideIdx: number,
  w: number,
  h: number
): { scale: number; tx: number; ty: number; rot: number; entryFlash: number; rgbSplitPx: number } {
  const s = w / 720;
  const dir = slideIdx % 2 === 0 ? 1 : -1;
  const motion = template.motionStyle ?? 'none';

  if (motion === 'velocity-pump') {
    // 2 rhythmic bass pumps per clip + snappy entry kick
    const beatPhase = (progress * 2) % 1;
    const pump = Math.exp(-beatPhase * 7.5);
    const shakeDecay = Math.exp(-progress * 9.5);
    return {
      scale: 1.04 + pump * 0.13,
      tx: Math.sin(progress * 44) * shakeDecay * 14 * s * dir,
      ty: Math.cos(progress * 52) * shakeDecay * 10 * s,
      rot: Math.sin(progress * 32) * shakeDecay * 0.032 * dir,
      entryFlash: Math.exp(-progress * 14) * 0.28,
      rgbSplitPx: pump > 0.45 ? pump * 10 * s : 0,
    };
  }

  if (motion === 'impact-shake') {
    const decay = Math.exp(-progress * 7.5);
    return {
      scale: 1.05 + decay * 0.16 + progress * 0.04,
      tx: Math.sin(progress * 62) * decay * 22 * s * dir,
      ty: Math.cos(progress * 54) * decay * 16 * s,
      rot: Math.sin(progress * 48) * decay * 0.045 * dir,
      entryFlash: Math.exp(-progress * 16) * 0.34,
      rgbSplitPx: decay * 18 * s,
    };
  }

  if (motion === 'drift-punch') {
    // Aggressive punch-in speed curve + engine micro-vibration
    const punch = easeOutExpo(progress);
    const vib = Math.exp(-progress * 6.5);
    return {
      scale: 1.02 + punch * 0.14 + vib * 0.08,
      tx: Math.sin(progress * 80) * vib * 11 * s,
      ty: Math.cos(progress * 74) * vib * 9 * s,
      rot: dir * (0.025 * vib - 0.012 * punch),
      entryFlash: Math.exp(-progress * 15) * 0.24,
      rgbSplitPx: vib * 12 * s,
    };
  }

  if (motion === 'anime-impact') {
    const snap = Math.exp(-progress * 9);
    return {
      scale: 1.03 + snap * 0.22,
      tx: Math.sin(progress * 58) * snap * 18 * s * dir,
      ty: Math.cos(progress * 66) * snap * 14 * s,
      rot: dir * snap * 0.05,
      entryFlash: Math.exp(-progress * 18) * 0.55,
      rgbSplitPx: snap * 16 * s,
    };
  }

  if (motion === 'strobe-flash') {
    const pop = Math.exp(-progress * 12);
    return {
      scale: 1.02 + pop * 0.08,
      tx: 0,
      ty: 0,
      rot: dir * pop * 0.018,
      entryFlash: pop * 0.42,
      rgbSplitPx: 0,
    };
  }

  if (motion === 'bw-flash-drop') {
    const dropFlash =
      progress >= 0.36 ? Math.exp(-(progress - 0.36) * 16) * 0.62 : 0;
    const dropKick =
      progress >= 0.36 ? Math.exp(-(progress - 0.36) * 10) * 0.1 : 0;
    return {
      scale: 1.02 + progress * 0.05 + dropKick,
      tx: 0,
      ty: 0,
      rot: 0,
      entryFlash: dropFlash,
      rgbSplitPx: dropKick > 0.02 ? dropKick * 90 * s : 0,
    };
  }

  if (motion === 'blur-focus-pull') {
    const settle = easeOutCubic(Math.min(1, progress / 0.55));
    return {
      scale: 1.12 - settle * 0.08 + progress * 0.03,
      tx: 0,
      ty: (1 - settle) * 10 * s,
      rot: 0,
      entryFlash: 0,
      rgbSplitPx: 0,
    };
  }

  if (motion === 'handheld-sway') {
    // Organic Alight Motion 3D-null camera figure-8 sway
    const theta = progress * Math.PI * 2 + slideIdx * 1.4;
    return {
      scale: 1.07 + Math.sin(theta * 0.5) * 0.025,
      tx: Math.sin(theta) * w * 0.018,
      ty: Math.sin(theta * 2) * h * 0.009,
      rot: Math.cos(theta) * 0.026,
      entryFlash: 0,
      rgbSplitPx: 0,
    };
  }

  if (motion === 'vhs-jitter') {
    const jitterStep = Math.floor(progress * 24);
    const jx = (Math.sin(jitterStep * 17.3 + slideIdx) * 0.5) * 6 * s;
    const jy = (Math.cos(jitterStep * 29.1 + slideIdx) * 0.5) * 4 * s;
    return {
      scale: 1.03,
      tx: jx,
      ty: jy,
      rot: 0,
      entryFlash: 0,
      rgbSplitPx: 4 * s,
    };
  }

  return { scale: 1, tx: 0, ty: 0, rot: 0, entryFlash: 0, rgbSplitPx: 0 };
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
  const filter = getFilterString(template, progress, w);
  const cam = getCameraMotionTransform(template, progress, slideIdx, w, h);

  ctx.fillStyle = '#08080A';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  if (cam.scale !== 1 || cam.tx !== 0 || cam.ty !== 0 || cam.rot !== 0) {
    ctx.translate(w / 2 + cam.tx, h / 2 + cam.ty);
    ctx.rotate(cam.rot);
    ctx.scale(cam.scale, cam.scale);
    ctx.translate(-w / 2, -h / 2);
  }

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
  } else if (template.layout === 'polaroid') {
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
  } else if (template.layout === 'dual-split' && secondaryImg && slideIdx % 2 === 1) {
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
  } else {
    // Automatic uniform 9:16 framing (landscape auto-rotates left/right, square fits over blur, portrait fills)
    drawAutoUniformSlide(ctx, img, w, h, progress, slideIdx, filter, landscapeTilt);
  }
  ctx.restore();

  // Chromatic RGB shockwave ghost on hard beat hits
  if (cam.rgbSplitPx > 1.2) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = Math.min(0.32, cam.rgbSplitPx / (38 * s));
    ctx.fillStyle = 'rgba(244, 63, 94, 0.32)';
    ctx.fillRect(0, 0, cam.rgbSplitPx * 1.4, h);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.32)';
    ctx.fillRect(w - cam.rgbSplitPx * 1.4, 0, cam.rgbSplitPx * 1.4, h);
    ctx.restore();
  }

  // Beat / cut entry exposure flash
  if (cam.entryFlash > 0.015) {
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.75, cam.entryFlash).toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
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

  if (transition === 'zoom-shake') {
    // CapCut Velocity "Beat Zoom Shake": hard slam zoom + RGB burst + spring shake
    const dir = slideIdx % 2 === 0 ? 1 : -1;
    const shake = Math.sin(t * 48) * Math.sin(t * Math.PI) * 18 * s;
    if (t < 0.5) {
      const p = easeInExpo(t * 2);
      const scale = 1 + p * 0.85;
      ctx.save();
      ctx.translate(w / 2 + shake, h / 2 - shake * 0.5);
      ctx.rotate(dir * p * 0.08);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.filter = `blur(${(p * 12 * s).toFixed(1)}px) brightness(${(1 + p * 0.35).toFixed(2)})`;
      ctx.drawImage(fromCanvas, 0, 0);
      ctx.restore();
    } else {
      const p = easeOutExpo((t - 0.5) * 2);
      const scale = 1.65 - p * 0.65;
      ctx.save();
      ctx.translate(w / 2 + shake, h / 2 + shake * 0.5);
      ctx.rotate(-dir * (1 - p) * 0.07);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.filter = `blur(${((1 - p) * 12 * s).toFixed(1)}px) brightness(${(1 + (1 - p) * 0.3).toFixed(2)})`;
      ctx.drawImage(toCanvas, 0, 0);
      ctx.restore();
    }
    const peak = Math.sin(t * Math.PI);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = peak * 0.4;
    ctx.drawImage(t < 0.5 ? fromCanvas : toCanvas, -peak * 22 * s, 0);
    ctx.fillStyle = `rgba(255,255,255,${(Math.pow(peak, 3) * 0.45).toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    return;
  }

  if (transition === 'blur-whip') {
    // High-velocity optical Blur Whip + midpoint flash
    const dir = slideIdx % 2 === 0 ? -1 : 1;
    const p = easeInOutExpo(t);
    const vel = Math.sin(t * Math.PI);
    const blurPx = (vel * 20 * s).toFixed(1);
    const fromX = dir * p * w;
    const toX = fromX - dir * w;
    ctx.save();
    ctx.filter = `blur(${blurPx}px) brightness(${(1 + vel * 0.28).toFixed(2)})`;
    ctx.drawImage(fromCanvas, fromX, 0);
    ctx.drawImage(toCanvas, toX, 0);
    ctx.restore();
    return;
  }

  if (transition === 'flash-cut') {
    // Snappy 0.5x Photo Dump 2-frame white strobe hit
    ctx.drawImage(t < 0.45 ? fromCanvas : toCanvas, 0, 0);
    const pulse = Math.pow(Math.sin(t * Math.PI), 1.2) * 0.88;
    ctx.fillStyle = `rgba(255, 255, 255, ${pulse.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    return;
  }

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

  if (template.grade === 'phonk-dark') {
    const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.16, w / 2, h / 2, h * 0.66);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(8,4,18,0.74)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    const aura = ctx.createLinearGradient(0, 0, w, h);
    aura.addColorStop(0, 'rgba(168, 85, 247, 0.14)');
    aura.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
    aura.addColorStop(1, 'rgba(244, 63, 94, 0.16)');
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, w, h);
  } else if (template.grade === 'hdr-chrome') {
    const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.25, w / 2, h / 2, h * 0.68);
    vig.addColorStop(0, 'rgba(255,255,255,0.04)');
    vig.addColorStop(1, 'rgba(2,6,14,0.58)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    const sheen = ctx.createLinearGradient(0, 0, w, h);
    sheen.addColorStop(0, 'rgba(56, 189, 248, 0.11)');
    sheen.addColorStop(1, 'rgba(15, 23, 42, 0.18)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);
  } else if (template.grade === 'euphoria-night') {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, 'rgba(20, 184, 166, 0.16)');
    grad.addColorStop(0.55, 'rgba(139, 92, 246, 0.12)');
    grad.addColorStop(1, 'rgba(244, 114, 182, 0.2)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, h * 0.68);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(6,4,14,0.52)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  } else if (template.grade === 'flash-night') {
    const spot = ctx.createRadialGradient(w * 0.5, h * 0.44, w * 0.08, w * 0.5, h * 0.5, h * 0.65);
    spot.addColorStop(0, 'rgba(255,255,255,0.14)');
    spot.addColorStop(0.55, 'rgba(0,0,0,0)');
    spot.addColorStop(1, 'rgba(0,0,0,0.68)');
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, w, h);
  } else if (template.grade === 'cyber-glitch') {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, 'rgba(34, 211, 238, 0.14)');
    grad.addColorStop(1, 'rgba(236, 72, 153, 0.16)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    const step = Math.max(5, Math.round(h / 160));
    for (let y = 0; y < h; y += step) {
      ctx.fillRect(0, y, w, 1.5);
    }
  } else if (template.grade === 'teal-amber') {
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
    template.overlay === 'kinetic-intro' ||
    template.overlay === 'rgb-pulse' ||
    template.overlay === 'speed-lines' ||
    template.overlay === 'halation-glow' ||
    template.overlay === 'vogue-bars'
  ) {
    // Visual-only Gen-Z FX overlays (zero forced text unless user types it)
    if (template.overlay === 'speed-lines') {
      const pulse = Math.exp(-((timeSec * 2.4) % 1) * 7.5);
      if (pulse > 0.06) {
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${(pulse * 0.42).toFixed(3)})`;
        ctx.lineWidth = 2.2 * s;
        for (let i = 0; i < 28; i += 1) {
          const angle = (i / 28) * Math.PI * 2 + Math.floor(timeSec * 12) * 0.11;
          const rInner = Math.min(w, h) * (0.44 + (i % 3) * 0.07);
          const rOuter = Math.max(w, h) * 0.78;
          ctx.beginPath();
          ctx.moveTo(Math.cos(angle) * rInner, Math.sin(angle) * rInner);
          ctx.lineTo(Math.cos(angle) * rOuter, Math.sin(angle) * rOuter);
          ctx.stroke();
        }
        ctx.restore();
      }
    } else if (template.overlay === 'rgb-pulse') {
      const pulse = Math.exp(-((timeSec * 2.1) % 1) * 6.5);
      if (pulse > 0.05) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const rim = ctx.createRadialGradient(w / 2, h / 2, w * 0.28, w / 2, h / 2, h * 0.66);
        rim.addColorStop(0, 'rgba(0,0,0,0)');
        rim.addColorStop(1, `rgba(168, 85, 247, ${(pulse * 0.34).toFixed(3)})`);
        ctx.fillStyle = rim;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    } else if (template.overlay === 'halation-glow') {
      const drift = 0.5 + 0.5 * Math.sin(timeSec * 1.1);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const glow = ctx.createRadialGradient(
        w * (0.2 + drift * 0.6),
        h * 0.24,
        14 * s,
        w * 0.5,
        h * 0.3,
        w * 0.85
      );
      glow.addColorStop(0, 'rgba(251, 113, 133, 0.22)');
      glow.addColorStop(0.5, 'rgba(253, 186, 116, 0.10)');
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    } else if (template.overlay === 'vogue-bars') {
      const pad = 26 * s;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = 1.4 * s;
      ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
      ctx.restore();
    }

    if (cleanTitle || cleanSub) {
      const yPos = template.layout === 'letterbox' ? h - h * 0.072 : h - 108 * s;
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = 12 * s;
      if (cleanTitle) {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `700 ${Math.round(34 * s)}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(cleanTitle, w / 2, yPos);
      }

      if (cleanSub) {
        ctx.fillStyle = 'rgba(228,228,231,0.82)';
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

function renderInnerSlideshowToCanvas(
  targetCtx: CanvasRenderingContext2D,
  clips: RenderClip[],
  timeSec: number,
  config: RenderConfig
): void {
  const w = targetCtx.canvas.width;
  const h = targetCtx.canvas.height;
  if (clips.length === 0) return;

  const slideDur = getSlideDuration(config.template, config.pace);
  const segs = clips.map((c, idx) => {
    const d = c.kind === 'video' ? Math.max(0.3, c.trimEnd - c.trimStart) : slideDur;
    return { clip: c, idx, dur: d };
  });
  const totalBg = segs.reduce((acc, s) => acc + s.dur, 0) || slideDur;
  const looped = ((timeSec % totalBg) + totalBg) % totalBg;

  let cursor = 0;
  let activeIdx = 0;
  for (let i = 0; i < segs.length; i += 1) {
    if (looped < cursor + segs[i].dur || i === segs.length - 1) {
      activeIdx = i;
      break;
    }
    cursor += segs[i].dur;
  }

  const seg = segs[activeIdx];
  const nextIdx = (activeIdx + 1) % segs.length;
  const nextSeg = segs[nextIdx];
  const localTime = Math.max(0, looped - cursor);
  const progress = clamp01(localTime / seg.dur);

  const activeTransition = getEffectiveTransition(config);
  const transDur =
    segs.length > 1 ? getTransitionDuration(activeTransition, seg.dur, nextSeg.dur) : 0;
  const inTrans = transDur > 0 && segs.length > 1 && localTime > seg.dur - transDur;
  const curImg = resolveDrawable(seg.clip);
  if (!curImg) return;
  const landscapeTilt: LandscapeTilt = config.landscapeTilt ?? 'right';

  if (inTrans) {
    const tRaw = clamp01((localTime - (seg.dur - transDur)) / transDur);
    const nextImg = resolveDrawable(nextSeg.clip) ?? curImg;
    const { fromCanvas, fromCtx, toCanvas, toCtx } = getTransitionBuffers(w, h);
    fromCtx.fillStyle = '#08080A';
    fromCtx.fillRect(0, 0, w, h);
    drawAutoUniformSlide(fromCtx, curImg, w, h, progress, activeIdx, 'none', landscapeTilt);
    toCtx.fillStyle = '#08080A';
    toCtx.fillRect(0, 0, w, h);
    drawAutoUniformSlide(toCtx, nextImg, w, h, tRaw * 0.15, nextIdx, 'none', landscapeTilt);
    renderInShotTransition(targetCtx, fromCanvas, toCanvas, w, h, tRaw, activeTransition, activeIdx);
  } else {
    targetCtx.fillStyle = '#08080A';
    targetCtx.fillRect(0, 0, w, h);
    drawAutoUniformSlide(targetCtx, curImg, w, h, progress, activeIdx, 'none', landscapeTilt);
  }
}

/**
 * Real-time Green Screen Chroma Key Compositor:
 * - When a user uploads a green-screen video (e.g. holding up a phone displaying green),
 *   keys out all green pixels with soft alpha feathering + spill suppression, auto-tracks
 *   the green screen bounding rectangle, and plays the remaining photos/clips with transitions
 *   cleanly INSIDE the mobile screen!
 * - In sample/demo mode (before a video is uploaded), displays an animated handheld phone mockup
 *   showing live transitions inside the screen so users immediately understand the effect.
 */
function renderGreenScreenChromaFrame(
  ctx: CanvasRenderingContext2D,
  timeSec: number,
  config: RenderConfig
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / 720;
  const allClips = getNormalizedClips(config);
  if (allClips.length === 0) return;

  const { fgClip, bgClips } = splitChromaClips(allClips, config.presetOverlayClip);
  const buffers = getTransitionBuffers(w, h);
  const { maskCanvas: bgCanvas, maskCtx: bgCtx, chromaCanvas, chromaCtx, chromaW, chromaH } = buffers;
  const landscapeTilt: LandscapeTilt = config.landscapeTilt ?? 'right';

  // 1. Render inner photo/clip slideshow with user's chosen transition onto bgCanvas
  renderInnerSlideshowToCanvas(bgCtx, bgClips, timeSec, config);

  // 2. DEMO PREVIEW MODE (no green-screen video uploaded yet): sleek animated handheld phone frame
  if (!fgClip) {
    const firstDrawable = resolveDrawable(bgClips[0]);
    if (firstDrawable) {
      drawBlurredBackdrop(ctx, firstDrawable, w, h);
    } else {
      ctx.fillStyle = '#0B0B10';
      ctx.fillRect(0, 0, w, h);
    }

    const swayX = Math.sin(timeSec * 1.45) * 14 * s;
    const swayY = Math.cos(timeSec * 1.15) * 10 * s;
    const tilt = Math.sin(timeSec * 1.05) * 0.045;

    const phoneW = w * 0.62;
    const phoneH = phoneW * (16 / 9) * 0.92;
    const px = (w - phoneW) / 2;
    const py = (h - phoneH) / 2;
    const bezel = 14 * s;
    const outerR = 44 * s;
    const innerR = 32 * s;

    ctx.save();
    ctx.translate(w / 2 + swayX, h / 2 + swayY);
    ctx.rotate(tilt);
    ctx.translate(-w / 2, -h / 2);

    // Phone drop shadow + metallic body
    ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
    ctx.shadowBlur = 46 * s;
    ctx.shadowOffsetY = 24 * s;
    ctx.fillStyle = '#18181B';
    roundedRectPath(ctx, px, py, phoneW, phoneH, outerR);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = 2.5 * s;
    ctx.stroke();

    // Inner keyed screen displaying the animated transitions live
    const sx = px + bezel;
    const sy = py + bezel;
    const sw = phoneW - bezel * 2;
    const sh = phoneH - bezel * 2;
    ctx.save();
    roundedRectPath(ctx, sx, sy, sw, sh, innerR);
    ctx.clip();
    ctx.drawImage(bgCanvas, 0, 0, w, h, sx, sy, sw, sh);

    // Subtle diagonal glass screen reflection
    const sheen = ctx.createLinearGradient(sx, sy, sx + sw, sy + sh * 0.65);
    sheen.addColorStop(0, 'rgba(255,255,255,0.12)');
    sheen.addColorStop(0.35, 'rgba(255,255,255,0.02)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.restore();

    // Dynamic island pill at top of phone screen
    const pillW = phoneW * 0.28;
    const pillH = 18 * s;
    ctx.fillStyle = '#09090B';
    roundedRectPath(ctx, w / 2 - pillW / 2, sy + 14 * s, pillW, pillH, 9 * s);
    ctx.fill();

    // Subtle green-key rim accent showing Chroma mode on demo card
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.45)';
    ctx.lineWidth = 2 * s;
    roundedRectPath(ctx, sx, sy, sw, sh, innerR);
    ctx.stroke();

    ctx.restore();
    drawTemplateOverlay(ctx, w, h, timeSec, config);
    return;
  }

  // 3. REAL CHROMA KEY MODE: key out green screen from user's uploaded video clip
  const fgDrawable = resolveDrawable(fgClip);
  if (!fgDrawable) {
    ctx.drawImage(bgCanvas, 0, 0, w, h);
    drawTemplateOverlay(ctx, w, h, timeSec, config);
    return;
  }

  chromaCtx.clearRect(0, 0, chromaW, chromaH);
  drawAutoUniformSlide(chromaCtx, fgDrawable, chromaW, chromaH, 0, 0, 'none', landscapeTilt);

  const imgData = chromaCtx.getImageData(0, 0, chromaW, chromaH);
  const data = imgData.data;

  const sens = Math.max(0.15, Math.min(0.95, config.chromaSensitivity ?? 0.55));
  // Dual HSV-Hue + Green-Excess chroma keyer: cleanly removes bright neon phone screens,
  // slightly overexposed yellow-green/cyan-green LCDs, AND dim room-lit green screens without hurting skin tones.
  const gMin = Math.round(92 - sens * 54); // ~62 at default 0.55
  const excessLow = Math.round(40 - sens * 34); // ~21 at default 0.55
  const excessSpan = Math.round(36 - sens * 10); // sharper feather edge
  const minSat = Math.max(0.14, 0.42 - sens * 0.28);

  const rowCounts = new Int32Array(chromaH);
  const colCounts = new Int32Array(chromaW);
  let strongGreenCount = 0;

  for (let y = 0; y < chromaH; y += 1) {
    const rowOffset = y * chromaW;
    for (let x = 0; x < chromaW; x += 1) {
      const idx = (rowOffset + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const maxRB = r > b ? r : b;
      const minC = r < b ? (r < g ? r : g) : b < g ? b : g;
      const greenExcess = g - maxRB;

      if (g > gMin && greenExcess > 4) {
        // Compute HSV saturation & hue only for green-dominant candidates (fast path)
        const delta = g - minC;
        const sat = g > 0 ? delta / g : 0;
        // Hue in degrees around green (120deg): 60 * ((b - r) / delta + 2)
        const hue = delta > 0 ? 60 * ((b - r) / delta + 2) : 120;
        const inGreenHue = hue >= 66 && hue <= 168;

        if (inGreenHue && sat >= minSat && greenExcess > excessLow) {
          const excessStrength = Math.min(1, (greenExcess - excessLow) / Math.max(12, excessSpan));
          const satBoost = Math.min(1, (sat - minSat) / Math.max(0.12, 0.35 - sens * 0.12));
          const keyStrength = Math.min(1, excessStrength * 0.72 + satBoost * 0.45);
          const alpha = Math.round((1 - keyStrength) * 255);
          data[idx + 3] = alpha;

          // Clean despill along phone bezels & fingers so zero green halo remains
          if (alpha > 0) {
            const neutralG = Math.round((r + b) * 0.5 + 4);
            if (g > neutralG) {
              data[idx + 1] = Math.round(g * (1 - keyStrength * 0.85) + neutralG * (keyStrength * 0.85));
            }
          }

          if (keyStrength > 0.52) {
            rowCounts[y] += 1;
            colCounts[x] += 1;
            strongGreenCount += 1;
          }
        } else if (inGreenHue && greenExcess > excessLow * 0.65 && sat >= minSat * 0.85) {
          // Subtle spill suppression on adjacent fringe pixels reflecting green phone light
          const neutralG = Math.round(maxRB + 4);
          if (g > neutralG) {
            data[idx + 1] = Math.round((g + neutralG) * 0.5);
          }
        }
      }
    }
  }

  chromaCtx.putImageData(imgData, 0, 0);

  // Detect robust bounding box of green screen region (ignoring stray single-pixel room noise)
  let minX = chromaW;
  let maxX = 0;
  let minY = chromaH;
  let maxY = 0;
  const minRowPixels = Math.max(6, Math.floor(chromaW * 0.032));
  const minColPixels = Math.max(6, Math.floor(chromaH * 0.022));

  if (strongGreenCount > chromaW * chromaH * 0.01) {
    for (let y = 0; y < chromaH; y += 1) {
      if (rowCounts[y] >= minRowPixels) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    for (let x = 0; x < chromaW; x += 1) {
      if (colCounts[x] >= minColPixels) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }

  // Composite: either fill entire 9:16 frame behind keyed person/AI overlay ('full-frame')
  // OR cover-fit neatly inside the detected green-screen rectangle ('detected-rect' for phones/frames)
  ctx.fillStyle = '#08080A';
  ctx.fillRect(0, 0, w, h);

  const fitMode = config.template.chromaFitMode ?? 'detected-rect';
  if (fitMode === 'detected-rect' && maxX > minX + 10 && maxY > minY + 10) {
    const scaleX = w / chromaW;
    const scaleY = h / chromaH;
    const rawW = (maxX - minX) * scaleX;
    const rawH = (maxY - minY) * scaleY;
    // Slight bleed margin (+4.5%) ensures zero black gap around tilted/curved phone screen corners
    const padX = rawW * 0.045;
    const padY = rawH * 0.045;
    const rx = Math.max(0, minX * scaleX - padX);
    const ry = Math.max(0, minY * scaleY - padY);
    const rw = Math.min(w - rx, rawW + padX * 2);
    const rh = Math.min(h - ry, rawH + padY * 2);

    // Cover-fit the 9:16 bgCanvas neatly inside (rx, ry, rw, rh)
    const srcRatio = w / h;
    const dstRatio = rw / Math.max(1, rh);
    let sx = 0;
    let sy = 0;
    let sw = w;
    let sh = h;
    if (dstRatio > srcRatio) {
      sh = w / dstRatio;
      sy = (h - sh) / 2;
    } else {
      sw = h * dstRatio;
      sx = (w - sw) / 2;
    }
    ctx.drawImage(bgCanvas, sx, sy, sw, sh, rx, ry, rw, rh);
  } else {
    ctx.drawImage(bgCanvas, 0, 0, w, h);
  }

  // Draw chroma-keyed foreground (hands, AI girl, phone bezel) cleanly over the background slideshow
  ctx.drawImage(chromaCanvas, 0, 0, chromaW, chromaH, 0, 0, w, h);
  drawTemplateOverlay(ctx, w, h, timeSec, config);
}

/**
 * Viral VN Diagonal Mirror-Mask Shadow Reveal:
 * Recreates the iconic VN Mirror Mask keyframe reveal — a silky feathered diagonal light slit
 * sweeps slowly across each portrait/clip out of pure obsidian pitch black, then blooms open on the beat.
 */
function renderVnShadowRevealFrame(
  ctx: CanvasRenderingContext2D,
  timeSec: number,
  config: RenderConfig,
  segments: ClipSegment[]
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / 720;
  const landscapeTilt: LandscapeTilt = config.landscapeTilt ?? 'right';
  const lastSeg = segments[segments.length - 1];
  const clampedTime = Math.max(0, Math.min(timeSec, lastSeg.endSec - 0.0001));

  let slideIdx = segments.length - 1;
  for (let i = 0; i < segments.length; i += 1) {
    if (clampedTime < segments[i].endSec) {
      slideIdx = i;
      break;
    }
  }

  const seg = segments[slideIdx];
  const localTime = Math.max(0, clampedTime - seg.startSec);
  const p = clamp01(localTime / Math.max(0.1, seg.durationSec));
  const drawable = resolveDrawable(seg.clip);
  if (!drawable) return;

  const { fromCanvas, fromCtx, maskCanvas, maskCtx } = getTransitionBuffers(w, h);

  // 1. Render full-bleed dramatic high-contrast portrait with slow cinema push-in
  fromCtx.fillStyle = '#000000';
  fromCtx.fillRect(0, 0, w, h);

  const beatBloom = p > 0.72 && p < 0.92 ? Math.sin(((p - 0.72) / 0.2) * Math.PI) : 0;
  const camScale = 1.03 + p * 0.1 + beatBloom * 0.045;
  fromCtx.save();
  fromCtx.translate(w / 2, h / 2);
  fromCtx.scale(camScale, camScale);
  fromCtx.translate(-w / 2, -h / 2);
  drawAutoUniformSlide(
    fromCtx,
    drawable,
    w,
    h,
    p * 0.35,
    slideIdx,
    'contrast(1.2) saturate(1.06) brightness(0.97)',
    landscapeTilt
  );
  fromCtx.restore();

  // 2. Build the sleek, razor-thin VN diagonal feathered Mirror Mask on maskCanvas
  // Sweeps a tight narrow diagonal beam across top-left -> eyes -> lower face -> bottom-right,
  // with a crisp brief beat bloom at the end before closing into obsidian shadow.
  let bandCenter = 0;
  let halfBand = 0.022;
  let feather = 0.072;
  let masterAlpha = 1;

  if (p < 0.78) {
    const sp = easeInOutSine(p / 0.78);
    bandCenter = -0.38 + sp * 0.76; // sleek narrow diagonal scan from hair -> eyes -> jaw -> bottom-right
    halfBand = 0.018 + Math.sin(sp * Math.PI) * 0.016;
    feather = 0.072;
    masterAlpha = p < 0.06 ? easeOutCubic(p / 0.06) : 1;
  } else if (p < 0.92) {
    const bp = (p - 0.78) / 0.14;
    bandCenter = 0.38 - easeOutCubic(bp) * 0.38; // centers smoothly on subject for brief beat reveal
    halfBand = 0.024 + easeOutExpo(bp) * 0.38;
    feather = 0.078 + bp * 0.065;
    masterAlpha = 1;
  } else {
    const fp = (p - 0.92) / 0.08;
    bandCenter = 0;
    halfBand = Math.max(0.01, 0.4 * (1 - easeInExpo(fp)));
    feather = 0.095;
    masterAlpha = 1 - easeInExpo(fp);
  }

  // Diagonal axis (~40 deg matching the VN Mirror Mask tutorial)
  const diagAngle = slideIdx % 2 === 0 ? 0.68 : -0.68; // ~39 degrees
  const diagLen = Math.hypot(w, h) * 0.62;
  const nx = Math.cos(diagAngle);
  const ny = Math.sin(diagAngle);

  maskCtx.clearRect(0, 0, w, h);
  const gx0 = w / 2 - nx * diagLen;
  const gy0 = h / 2 - ny * diagLen;
  const gx1 = w / 2 + nx * diagLen;
  const gy1 = h / 2 + ny * diagLen;

  const grad = maskCtx.createLinearGradient(gx0, gy0, gx1, gy1);
  const cNorm = 0.5 + bandCenter * 0.5;
  const s0 = clamp01(cNorm - halfBand - feather);
  const s1 = clamp01(cNorm - halfBand);
  const s2 = clamp01(cNorm + halfBand);
  const s3 = clamp01(cNorm + halfBand + feather);

  grad.addColorStop(0, 'rgba(255,255,255,0)');
  if (s0 > 0) grad.addColorStop(s0, 'rgba(255,255,255,0)');
  grad.addColorStop(s1, `rgba(255,255,255,${masterAlpha.toFixed(3)})`);
  grad.addColorStop(s2, `rgba(255,255,255,${masterAlpha.toFixed(3)})`);
  if (s3 < 1) grad.addColorStop(s3, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');

  maskCtx.save();
  maskCtx.globalCompositeOperation = 'source-over';
  maskCtx.fillStyle = grad;
  maskCtx.fillRect(0, 0, w, h);
  maskCtx.globalCompositeOperation = 'source-in';
  maskCtx.drawImage(fromCanvas, 0, 0, w, h);
  maskCtx.restore();

  // 3. Composite onto pure pitch-black studio canvas
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(maskCanvas, 0, 0, w, h);

  // Subtle rim-light atmospheric bloom during the beat open
  if (beatBloom > 0.02) {
    ctx.save();
    ctx.globalAlpha = beatBloom * 0.16;
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.restore();
  }

  // Optional crisp minimal title/subtitle ONLY if user typed one
  if (config.title.trim() || config.subtitle.trim()) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 18 * s;
    if (config.title.trim()) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.font = `700 ${Math.round(38 * s)}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillText(config.title.trim().toUpperCase(), w / 2, h - 148 * s);
    }
    if (config.subtitle.trim()) {
      ctx.fillStyle = 'rgba(212, 212, 216, 0.72)';
      ctx.font = `500 ${Math.round(18 * s)}px "JetBrains Mono", monospace`;
      ctx.fillText(config.subtitle.trim().toUpperCase(), w / 2, h - 108 * s);
    }
    ctx.restore();
  }

  if (config.watermarkEnabled && config.watermarkText.trim()) {
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = `500 ${Math.round(16 * s)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 6 * s;
    ctx.fillText(config.watermarkText.trim(), w - 38 * s, 42 * s);
    ctx.restore();
  }
}

// Deterministic cubic Bezier evaluator + tangent for animated Travel Map Route
function evalCubicBezier(
  t: number,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number]
): { x: number; y: number; angle: number } {
  const mt = 1 - t;
  const x =
    mt * mt * mt * p0[0] +
    3 * mt * mt * t * p1[0] +
    3 * mt * t * t * p2[0] +
    t * t * t * p3[0];
  const y =
    mt * mt * mt * p0[1] +
    3 * mt * mt * t * p1[1] +
    3 * mt * t * t * p2[1] +
    t * t * t * p3[1];
  const dx =
    3 * mt * mt * (p1[0] - p0[0]) +
    6 * mt * t * (p2[0] - p1[0]) +
    3 * t * t * (p3[0] - p2[0]);
  const dy =
    3 * mt * mt * (p1[1] - p0[1]) +
    6 * mt * t * (p2[1] - p1[1]) +
    3 * t * t * (p3[1] - p2[1]);
  return { x, y, angle: Math.atan2(dy, dx) };
}

function drawPolygonPath(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  if (pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const mx = (prev[0] + curr[0]) * 0.5;
    const my = (prev[1] + curr[1]) * 0.5;
    ctx.quadraticCurveTo(prev[0], prev[1], mx, my);
  }
  ctx.closePath();
}

const MAP_LANDMASSES: [number, number][][] = [
  // Western Peninsula (Departure landmass)
  [
    [120, 820], [270, 760], [420, 810], [520, 910], [560, 1080],
    [490, 1260], [340, 1340], [180, 1270], [95, 1060],
  ],
  // Central Archipelagos
  [
    [590, 690], [720, 620], [840, 670], [880, 790], [790, 890], [640, 850],
  ],
  [
    [760, 960], [860, 930], [930, 1020], [850, 1110], [740, 1050],
  ],
  // Northern / Eastern Continent (Arrival landmass)
  [
    [820, 140], [1080, 110], [1340, 190], [1480, 380], [1460, 610],
    [1310, 740], [1120, 710], [990, 560], [920, 370],
  ],
  // Far Southern Coastal Ridge
  [
    [1080, 1060], [1280, 1020], [1440, 1140], [1390, 1340], [1170, 1380], [1040, 1220],
  ],
];

const MAP_AMBIENT_CITIES: [number, number, string][] = [
  [240, 930, 'WEST PORT'],
  [445, 985, 'BAY'],
  [745, 745, 'ISLE'],
  [1040, 310, 'NORTH RIDGE'],
  [1365, 575, 'COAST'],
];

/**
 * Viral 3D Animated Travel Map Route Intro:
 * Camera glides & zooms across a stylized dark cartographic map following a glowing flight curve
 * with a tangent-rotated airplane + ground shadow, pulsing pins, live KM counter, then zooms straight
 * through the destination pin into Clip #1!
 */
function renderMapRouteIntroFrame(
  ctx: CanvasRenderingContext2D,
  timeSec: number,
  introDur: number,
  config: RenderConfig,
  segments: ClipSegment[]
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / 720;
  const landscapeTilt: LandscapeTilt = config.landscapeTilt ?? 'right';

  const fromLabel = config.title.trim().toUpperCase() || 'ORIGIN';
  const toLabel = config.subtitle.trim().toUpperCase() || 'DESTINATION';

  const p0: [number, number] = [335, 1115];
  const p1: [number, number] = [445, 690];
  const p2: [number, number] = [945, 760];
  const p3: [number, number] = [1215, 425];

  const flightEnd = introDur * 0.76; // 0..2.55s map flight, 2.55..3.35s hyper-zoom into Clip #1
  const flightRaw = clamp01(timeSec / Math.max(0.1, flightEnd));
  const flightP = easeInOutSine(flightRaw);
  const zoomP = clamp01((timeSec - flightEnd) / Math.max(0.1, introDur - flightEnd));

  const planePos = evalCubicBezier(flightP, p0, p1, p2, p3);

  // Camera smoothly tracks ahead of plane, then locks onto destination pin and hyper-zooms in!
  const camFocusX = planePos.x * (1 - zoomP * 0.65) + p3[0] * (zoomP * 0.65);
  const camFocusY = planePos.y * (1 - zoomP * 0.65) + p3[1] * (zoomP * 0.65);
  const baseScale = (w / 1020) * (1.06 + flightP * 0.36);
  const camScale = baseScale * (1 + easeInExpo(zoomP) * 7.2);
  const camTilt = Math.sin(flightP * Math.PI) * 0.055 * (1 - zoomP);

  // 1. Deep Cartographic Ocean Backdrop
  const ocean = ctx.createRadialGradient(w * 0.5, h * 0.45, w * 0.08, w * 0.5, h * 0.5, h * 0.85);
  ocean.addColorStop(0, '#0C2138');
  ocean.addColorStop(0.55, '#071424');
  ocean.addColorStop(1, '#040B14');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, w, h);

  // 2. Transform into virtual world map coordinates
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(camTilt);
  ctx.scale(camScale, camScale);
  ctx.translate(-camFocusX, -camFocusY);

  // Subtle lat/lon cartographic grid
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.085)';
  ctx.lineWidth = 1.4;
  for (let gx = 0; gx <= 1600; gx += 120) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, 1600);
    ctx.stroke();
  }
  for (let gy = 0; gy <= 1600; gy += 120) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(1600, gy);
    ctx.stroke();
  }

  // Stylized dark landmasses with coastal glow + inner topographic contour rings
  for (const poly of MAP_LANDMASSES) {
    // Outer soft coastal shelf glow
    ctx.save();
    ctx.shadowColor = 'rgba(56, 189, 248, 0.25)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#112236';
    drawPolygonPath(ctx, poly);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(125, 211, 252, 0.34)';
    ctx.lineWidth = 2.4;
    drawPolygonPath(ctx, poly);
    ctx.stroke();

    // Inner subtle topographic elevation contour
    const cx = poly.reduce((acc, pt) => acc + pt[0], 0) / poly.length;
    const cy = poly.reduce((acc, pt) => acc + pt[1], 0) / poly.length;
    const inner1 = poly.map(([px, py]): [number, number] => [
      cx + (px - cx) * 0.72,
      cy + (py - cy) * 0.72,
    ]);
    const inner2 = poly.map(([px, py]): [number, number] => [
      cx + (px - cx) * 0.44,
      cy + (py - cy) * 0.44,
    ]);
    ctx.fillStyle = 'rgba(26, 48, 72, 0.55)';
    drawPolygonPath(ctx, inner1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    drawPolygonPath(ctx, inner2);
    ctx.stroke();
  }

  // Ambient twinkling background cities for authentic map richness
  ctx.font = '600 13px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const [cx, cy, name] of MAP_AMBIENT_CITIES) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(148, 163, 184, 0.32)';
    ctx.fillText(name, cx + 10, cy);
  }

  // Faint dashed preview of full route ahead
  ctx.save();
  ctx.setLineDash([12, 12]);
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.28)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  ctx.stroke();
  ctx.restore();

  // Luminous progressive glowing flight trail behind the plane
  const steps = 64;
  const maxStep = Math.max(1, Math.floor(flightP * steps));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(56, 189, 248, 0.85)';
  ctx.shadowBlur = 22;
  const trailGrad = ctx.createLinearGradient(p0[0], p0[1], p3[0], p3[1]);
  trailGrad.addColorStop(0, '#38BDF8');
  trailGrad.addColorStop(0.6, '#F59E0B');
  trailGrad.addColorStop(1, '#FDE047');
  ctx.strokeStyle = trailGrad;
  ctx.lineWidth = 7;
  ctx.beginPath();
  for (let i = 0; i <= maxStep; i += 1) {
    const t = Math.min(flightP, i / steps);
    const pt = evalCubicBezier(t, p0, p1, p2, p3);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
  ctx.restore();

  // Departure & Arrival pulsing pins + crisp city badges
  const drawCityPin = (
    px: number,
    py: number,
    label: string,
    color: string,
    pulsePhase: number,
    highlight: boolean
  ) => {
    const ringR = 16 + ((timeSec * 28 + pulsePhase) % 34);
    const ringAlpha = Math.max(0, 1 - (ringR - 16) / 34) * (highlight ? 0.85 : 0.45);
    ctx.strokeStyle = color;
    ctx.globalAlpha = ringAlpha;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Pin core
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, highlight ? 11 : 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // City label plate
    ctx.save();
    ctx.font = '800 24px "Plus Jakarta Sans", sans-serif';
    const tw = ctx.measureText(label).width;
    const padX = 16;
    const bw = tw + padX * 2;
    const bh = 40;
    const bx = px - bw / 2;
    const by = py - 62;
    ctx.fillStyle = 'rgba(6, 12, 22, 0.86)';
    roundedRectPath(ctx, bx, by, bw, bh, 12);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px, by + bh / 2 + 1);
    ctx.restore();
  };

  drawCityPin(p0[0], p0[1], fromLabel, '#38BDF8', 0, true);
  drawCityPin(p3[0], p3[1], toLabel, '#F59E0B', 17, flightP > 0.72);

  // Sleek vector airplane icon with realistic altitude ground shadow!
  const altitude = Math.sin(flightP * Math.PI); // peaks mid-flight for realistic takeoff/landing
  const shadowOff = 14 + altitude * 34;
  const drawPlaneGlyph = (scalePx: number) => {
    ctx.beginPath();
    ctx.moveTo(26 * scalePx, 0);
    ctx.lineTo(6 * scalePx, -6 * scalePx);
    ctx.lineTo(-10 * scalePx, -26 * scalePx);
    ctx.lineTo(-17 * scalePx, -24 * scalePx);
    ctx.lineTo(-8 * scalePx, -5 * scalePx);
    ctx.lineTo(-22 * scalePx, -4 * scalePx);
    ctx.lineTo(-28 * scalePx, -12 * scalePx);
    ctx.lineTo(-32 * scalePx, -11 * scalePx);
    ctx.lineTo(-28 * scalePx, 0);
    ctx.lineTo(-32 * scalePx, 11 * scalePx);
    ctx.lineTo(-28 * scalePx, 12 * scalePx);
    ctx.lineTo(-22 * scalePx, 4 * scalePx);
    ctx.lineTo(-8 * scalePx, 5 * scalePx);
    ctx.lineTo(-17 * scalePx, 24 * scalePx);
    ctx.lineTo(-10 * scalePx, 26 * scalePx);
    ctx.lineTo(6 * scalePx, 6 * scalePx);
    ctx.closePath();
    ctx.fill();
  };

  // Ground shadow
  ctx.save();
  ctx.translate(planePos.x + shadowOff * 0.55, planePos.y + shadowOff);
  ctx.rotate(planePos.angle);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  drawPlaneGlyph(0.95);
  ctx.restore();

  // Main bright airplane
  ctx.save();
  ctx.translate(planePos.x, planePos.y);
  ctx.rotate(planePos.angle);
  ctx.shadowColor = 'rgba(253, 224, 71, 0.85)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#FFFFFF';
  drawPlaneGlyph(1.15 + altitude * 0.25);
  ctx.restore();

  ctx.restore(); // exit virtual world map coordinates

  // 3. Cinematic tilt-shift edge vignette + live minimal flight progress HUD
  const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.24, w / 2, h / 2, h * 0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(3, 8, 16, 0.72)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  if (zoomP < 0.45) {
    const hudAlpha = 1 - zoomP / 0.45;
    const totalKm = 640;
    const currentKm = Math.round(flightP * totalKm);
    ctx.save();
    ctx.globalAlpha = hudAlpha;
    const cardW = w - 84 * s;
    const cardH = 82 * s;
    const cardX = 42 * s;
    const cardY = h - 146 * s;

    ctx.fillStyle = 'rgba(6, 13, 24, 0.78)';
    roundedRectPath(ctx, cardX, cardY, cardW, cardH, 18 * s);
    ctx.fill();
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.24)';
    ctx.lineWidth = 1.5 * s;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `700 ${Math.round(22 * s)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillText(`${fromLabel}  ✈  ${toLabel}`, cardX + 22 * s, cardY + 29 * s);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#38BDF8';
    ctx.font = `600 ${Math.round(18 * s)}px "JetBrains Mono", monospace`;
    ctx.fillText(`${currentKm} KM`, cardX + cardW - 22 * s, cardY + 29 * s);

    // Slim route progress track
    const barX = cardX + 22 * s;
    const barY = cardY + 56 * s;
    const barW = cardW - 44 * s;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    roundedRectPath(ctx, barX, barY, barW, 6 * s, 3 * s);
    ctx.fill();

    const fillGrad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    fillGrad.addColorStop(0, '#38BDF8');
    fillGrad.addColorStop(1, '#F59E0B');
    ctx.fillStyle = fillGrad;
    roundedRectPath(ctx, barX, barY, Math.max(8 * s, barW * flightP), 6 * s, 3 * s);
    ctx.fill();
    ctx.restore();
  }

  // 4. Seamless zoom-through breakthrough right into Clip #1!
  if (zoomP > 0.35 && segments.length > 0) {
    const firstDrawable = resolveDrawable(segments[0].clip);
    if (firstDrawable) {
      const revealP = easeOutCubic((zoomP - 0.35) / 0.65);
      const { fromCanvas, fromCtx } = getTransitionBuffers(w, h);
      fromCtx.fillStyle = '#08080A';
      fromCtx.fillRect(0, 0, w, h);
      drawAutoUniformSlide(
        fromCtx,
        firstDrawable,
        w,
        h,
        0,
        0,
        'contrast(1.1) saturate(1.18)',
        landscapeTilt
      );
      ctx.save();
      ctx.globalAlpha = revealP;
      const inScale = 1.24 - revealP * 0.24;
      ctx.translate(w / 2, h / 2);
      ctx.scale(inScale, inScale);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(fromCanvas, 0, 0, w, h);
      ctx.restore();
    }
  }

  if (zoomP > 0.55) {
    const flashP = (zoomP - 0.55) / 0.45;
    const flashAlpha = Math.sin(flashP * Math.PI) * 0.58;
    ctx.fillStyle = `rgba(224, 242, 254, ${flashAlpha.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
  }

  if (config.watermarkEnabled && config.watermarkText.trim()) {
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = `500 ${Math.round(16 * s)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.56)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 6 * s;
    ctx.fillText(config.watermarkText.trim(), w - 38 * s, 42 * s);
    ctx.restore();
  }
}

// Accurate stylized India map coastline + Sri Lanka in 1600x1600 virtual cartographic space
const INDIA_OUTLINE_PTS: [number, number][] = [
  [545, 165], // Northern crown
  [655, 130], // Ladakh north
  [760, 175], // Ladakh east
  [735, 290], // Himachal / Uttarakhand
  [825, 365], // Nepal border west
  [975, 445], // Bihar / Sikkim north
  [1095, 415], // Sikkim / Bhutan
  [1215, 365], // Arunachal north
  [1325, 410], // Arunachal east
  [1285, 515], // Nagaland / Manipur
  [1215, 620], // Mizoram
  [1145, 565], // Tripura / Meghalaya
  [1055, 565], // West Bengal / Sundarbans
  [1025, 665], // Odisha coast
  [935, 780], // Andhra north coast
  [825, 895], // Andhra south coast
  [785, 1020], // Chennai / Tamil Nadu east
  [765, 1170], // Rameswaram
  [655, 1365], // Kanyakumari southern tip
  [585, 1235], // Kerala Malabar coast
  [540, 1085], // Mangalore / Karnataka coast
  [485, 955], // Goa coast
  [445, 820], // Mumbai / Konkan coast
  [410, 715], // Surat / Gulf of Khambhat
  [305, 725], // Saurashtra south
  [275, 640], // Dwarka / Kutch
  [350, 565], // Rajasthan border
  [415, 445], // Jaisalmer / Bikaner
  [495, 320], // Punjab / Amritsar
  [485, 225], // Jammu / Kashmir west
];

const SRI_LANKA_PTS: [number, number][] = [
  [765, 1295],
  [815, 1345],
  [805, 1435],
  [750, 1450],
  [725, 1370],
];

const INDIA_CITIES: { keys: string[]; label: string; x: number; y: number }[] = [
  { keys: ['LADAKH', 'LEH'], label: 'LADAKH', x: 675, y: 205 },
  { keys: ['SRINAGAR', 'KASHMIR'], label: 'KASHMIR', x: 565, y: 235 },
  { keys: ['SHIMLA', 'MANALI', 'HIMACHAL'], label: 'MANALI', x: 655, y: 315 },
  { keys: ['DELHI', 'NEW DELHI', 'NCR', 'NOIDA', 'GURGAON'], label: 'DELHI', x: 660, y: 445 },
  { keys: ['JAIPUR', 'RAJASTHAN', 'UDAIPUR'], label: 'JAIPUR', x: 560, y: 525 },
  { keys: ['LUCKNOW', 'AGRA', 'UP'], label: 'LUCKNOW', x: 775, y: 500 },
  { keys: ['VARANASI', 'BANARAS', 'KASHI'], label: 'VARANASI', x: 860, y: 545 },
  { keys: ['PATNA', 'BIHAR'], label: 'PATNA', x: 935, y: 540 },
  { keys: ['KOLKATA', 'CALCUTTA', 'BENGAL'], label: 'KOLKATA', x: 1035, y: 635 },
  { keys: ['GUWAHATI', 'ASSAM', 'SHILLONG'], label: 'ASSAM', x: 1185, y: 475 },
  { keys: ['AHMEDABAD', 'GUJARAT', 'SURAT'], label: 'GUJARAT', x: 425, y: 675 },
  { keys: ['BHOPAL', 'INDORE', 'MP'], label: 'INDORE', x: 605, y: 670 },
  { keys: ['MUMBAI', 'BOMBAY'], label: 'MUMBAI', x: 465, y: 820 },
  { keys: ['PUNE'], label: 'PUNE', x: 505, y: 855 },
  { keys: ['HYDERABAD', 'HYD', 'TELANGANA'], label: 'HYDERABAD', x: 715, y: 895 },
  { keys: ['GOA', 'PANJIM', 'MADGAON'], label: 'GOA', x: 505, y: 970 },
  { keys: ['BENGALURU', 'BANGALORE', 'BLR'], label: 'BENGALURU', x: 675, y: 1075 },
  { keys: ['CHENNAI', 'MADRAS'], label: 'CHENNAI', x: 785, y: 1065 },
  { keys: ['KERALA', 'KOCHI', 'COCHIN', 'MUNNAR', 'TRIVANDRUM'], label: 'KERALA', x: 615, y: 1245 },
  { keys: ['KANYAKUMARI', 'RAMESWARAM', 'MADURAI'], label: 'KANYAKUMARI', x: 660, y: 1335 },
];

function lookupIndiaCity(raw: string, fallback: [number, number]): [number, number] {
  const clean = raw.trim().toUpperCase();
  if (!clean) return fallback;
  const exact = INDIA_CITIES.find((c) => c.keys.some((k) => clean === k || clean.includes(k)));
  if (exact) return [exact.x, exact.y];
  return fallback;
}

/**
 * Viral India Train Map Route Intro:
 * Animated Vande Bharat / Express Train with glowing headlight & articulated coaches gliding along a
 * detailed saffron-gold railway track across an authentic India map silhouette between any two cities!
 */
function renderIndiaTrainMapIntroFrame(
  ctx: CanvasRenderingContext2D,
  timeSec: number,
  introDur: number,
  config: RenderConfig,
  segments: ClipSegment[]
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / 720;
  const landscapeTilt: LandscapeTilt = config.landscapeTilt ?? 'right';

  const fromLabel = config.title.trim().toUpperCase() || 'DELHI';
  const toLabel = config.subtitle.trim().toUpperCase() || 'GOA';

  const p0 = lookupIndiaCity(fromLabel, [660, 445]); // Delhi default
  const p3 = lookupIndiaCity(toLabel, [505, 970]); // Goa default

  // Build graceful scenic railway Bezier curving across India's heartland
  const dx = p3[0] - p0[0];
  const dy = p3[1] - p0[1];
  const distPx = Math.max(120, Math.hypot(dx, dy));
  const perpX = -dy / distPx;
  const perpY = dx / distPx;
  const bend = Math.min(180, distPx * 0.24);
  const p1: [number, number] = [
    p0[0] + dx * 0.32 + perpX * bend * 0.85,
    p0[1] + dy * 0.32 + perpY * bend * 0.85,
  ];
  const p2: [number, number] = [
    p0[0] + dx * 0.68 - perpX * bend * 0.65,
    p0[1] + dy * 0.68 - perpY * bend * 0.65,
  ];

  const rideEnd = introDur * 0.78;
  const rideRaw = clamp01(timeSec / Math.max(0.1, rideEnd));
  const rideP = easeInOutSine(rideRaw);
  const zoomP = clamp01((timeSec - rideEnd) / Math.max(0.1, introDur - rideEnd));

  const enginePos = evalCubicBezier(rideP, p0, p1, p2, p3);

  // Dynamic map camera: starts wide enough to recognize India's iconic shape, tracks the express train,
  // then hyper-zooms straight into the arrival station!
  const camFocusX =
    (710 * (1 - rideP * 0.65) + enginePos.x * (rideP * 0.65)) * (1 - zoomP * 0.72) +
    p3[0] * (zoomP * 0.72);
  const camFocusY =
    (760 * (1 - rideP * 0.65) + enginePos.y * (rideP * 0.65)) * (1 - zoomP * 0.72) +
    p3[1] * (zoomP * 0.72);
  const baseScale = (w / 1180) * (1.02 + rideP * 0.56);
  const camScale = baseScale * (1 + easeInExpo(zoomP) * 7.5);
  const camTilt = Math.sin(rideP * Math.PI) * 0.032 * (1 - zoomP);

  // 1. Deep Indian Ocean Midnight Backdrop
  const ocean = ctx.createRadialGradient(w * 0.5, h * 0.45, w * 0.08, w * 0.5, h * 0.5, h * 0.85);
  ocean.addColorStop(0, '#0E1C2F');
  ocean.addColorStop(0.58, '#07111E');
  ocean.addColorStop(1, '#040810');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, w, h);

  // 2. Virtual India Map World Coordinates
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(camTilt);
  ctx.scale(camScale, camScale);
  ctx.translate(-camFocusX, -camFocusY);

  // Subtle lat/lon cartographic grid
  ctx.strokeStyle = 'rgba(249, 115, 22, 0.075)';
  ctx.lineWidth = 1.4;
  for (let gx = 0; gx <= 1600; gx += 120) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, 1600);
    ctx.stroke();
  }
  for (let gy = 0; gy <= 1600; gy += 120) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(1600, gy);
    ctx.stroke();
  }

  // Stylized India Silhouette with warm saffron-amber & cyan coastal relief
  ctx.save();
  ctx.shadowColor = 'rgba(249, 115, 22, 0.34)';
  ctx.shadowBlur = 32;
  const landGrad = ctx.createLinearGradient(550, 150, 720, 1380);
  landGrad.addColorStop(0, '#1B2A42');
  landGrad.addColorStop(0.52, '#132236');
  landGrad.addColorStop(1, '#102433');
  ctx.fillStyle = landGrad;
  drawPolygonPath(ctx, INDIA_OUTLINE_PTS);
  ctx.fill();
  ctx.restore();

  // Crisp glowing India border outline
  ctx.strokeStyle = 'rgba(251, 146, 60, 0.55)';
  ctx.lineWidth = 3.2;
  drawPolygonPath(ctx, INDIA_OUTLINE_PTS);
  ctx.stroke();

  // Inner Deccan topographic contour rings
  const indCx = 685;
  const indCy = 740;
  const innerContour = INDIA_OUTLINE_PTS.map(([px, py]): [number, number] => [
    indCx + (px - indCx) * 0.68,
    indCy + (py - indCy) * 0.68,
  ]);
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.13)';
  ctx.lineWidth = 1.6;
  drawPolygonPath(ctx, innerContour);
  ctx.stroke();

  // Sri Lanka island
  ctx.fillStyle = '#102033';
  drawPolygonPath(ctx, SRI_LANKA_PTS);
  ctx.fill();
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Subtle ambient Indian cities so the map feels unmistakably like India!
  const ambientKeys = ['LADAKH', 'DELHI', 'JAIPUR', 'MUMBAI', 'HYDERABAD', 'KOLKATA', 'BENGALURU', 'CHENNAI', 'KERALA'];
  ctx.font = '600 14px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const city of INDIA_CITIES) {
    if (!ambientKeys.includes(city.label)) continue;
    if (city.label === fromLabel || city.label === toLabel) continue;
    ctx.fillStyle = 'rgba(253, 186, 116, 0.45)';
    ctx.beginPath();
    ctx.arc(city.x, city.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(203, 213, 225, 0.38)';
    ctx.fillText(city.label, city.x + 9, city.y);
  }

  // Full railway sleeper track ahead (perpendicular railway cross-ties!)
  const tieCount = 54;
  ctx.strokeStyle = 'rgba(251, 146, 60, 0.3)';
  ctx.lineWidth = 2.6;
  for (let i = 0; i <= tieCount; i += 1) {
    const t = i / tieCount;
    const pt = evalCubicBezier(t, p0, p1, p2, p3);
    const nx = -Math.sin(pt.angle) * 9;
    const ny = Math.cos(pt.angle) * 9;
    ctx.beginPath();
    ctx.moveTo(pt.x - nx, pt.y - ny);
    ctx.lineTo(pt.x + nx, pt.y + ny);
    ctx.stroke();
  }

  // Dual steel rails preview ahead
  ctx.strokeStyle = 'rgba(255, 237, 213, 0.24)';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  ctx.stroke();

  // Glowing saffron-gold active railway track completed behind the train
  const steps = 64;
  const maxStep = Math.max(1, Math.floor(rideP * steps));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(249, 115, 22, 0.9)';
  ctx.shadowBlur = 20;
  const railGrad = ctx.createLinearGradient(p0[0], p0[1], p3[0], p3[1]);
  railGrad.addColorStop(0, '#F97316');
  railGrad.addColorStop(0.55, '#FACC15');
  railGrad.addColorStop(1, '#FEF08A');
  ctx.strokeStyle = railGrad;
  ctx.lineWidth = 7;
  ctx.beginPath();
  for (let i = 0; i <= maxStep; i += 1) {
    const t = Math.min(rideP, i / steps);
    const pt = evalCubicBezier(t, p0, p1, p2, p3);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
  ctx.restore();

  // Station Pins (Departure & Arrival)
  const drawStationPin = (
    px: number,
    py: number,
    label: string,
    color: string,
    pulseOffset: number,
    highlight: boolean
  ) => {
    const ringR = 16 + ((timeSec * 30 + pulseOffset) % 34);
    const ringAlpha = Math.max(0, 1 - (ringR - 16) / 34) * (highlight ? 0.85 : 0.45);
    ctx.strokeStyle = color;
    ctx.globalAlpha = ringAlpha;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, highlight ? 11 : 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.font = '800 24px "Plus Jakarta Sans", sans-serif';
    const tw = ctx.measureText(label).width;
    const bw = tw + 34;
    const bh = 40;
    const bx = px - bw / 2;
    const by = py - 62;
    ctx.fillStyle = 'rgba(10, 12, 20, 0.88)';
    roundedRectPath(ctx, bx, by, bw, bh, 12);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px, by + bh / 2 + 1);
    ctx.restore();
  };

  drawStationPin(p0[0], p0[1], fromLabel, '#F97316', 0, true);
  drawStationPin(p3[0], p3[1], toLabel, '#22C55E', 16, rideP > 0.72);

  // Articulated 4-Car Vande Bharat / Express Train gliding smoothly along the curve!
  const carCount = 4;
  const carSpacingT = 0.048;

  // Warm headlight beam shining ahead of the locomotive
  ctx.save();
  ctx.translate(enginePos.x, enginePos.y);
  ctx.rotate(enginePos.angle);
  const beamGrad = ctx.createLinearGradient(16, 0, 125, 0);
  beamGrad.addColorStop(0, 'rgba(254, 240, 138, 0.58)');
  beamGrad.addColorStop(1, 'rgba(254, 240, 138, 0)');
  ctx.fillStyle = beamGrad;
  ctx.beginPath();
  ctx.moveTo(16, -5);
  ctx.lineTo(125, -34);
  ctx.lineTo(125, 34);
  ctx.lineTo(16, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Draw coaches from back to front so locomotive renders crispest on top
  for (let c = carCount - 1; c >= 0; c -= 1) {
    const carT = rideP - c * carSpacingT;
    if (carT < 0) continue;
    const pos = evalCubicBezier(carT, p0, p1, p2, p3);
    const isLoco = c === 0;
    const carLen = isLoco ? 36 : 30;
    const carW = 14;

    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(pos.angle);

    // Track drop shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    roundedRectPath(ctx, -carLen / 2 + 3, -carW / 2 + 5, carLen, carW, isLoco ? 7 : 4);
    ctx.fill();

    // Coach body (white Vande Bharat aerodynamic shell)
    ctx.shadowColor = isLoco ? 'rgba(250, 204, 21, 0.85)' : 'rgba(249, 115, 22, 0.5)';
    ctx.shadowBlur = isLoco ? 16 : 8;
    ctx.fillStyle = isLoco ? '#FFFFFF' : '#F1F5F9';
    roundedRectPath(ctx, -carLen / 2, -carW / 2, carLen, carW, isLoco ? 7 : 4);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Iconic saffron racing stripe along each coach
    ctx.fillStyle = '#F97316';
    ctx.fillRect(-carLen / 2 + 3, -2, carLen - 6, 4);

    // Dark tinted cockpit / coach window accents
    ctx.fillStyle = '#0F172A';
    if (isLoco) {
      roundedRectPath(ctx, carLen / 2 - 11, -carW / 2 + 2.5, 7, carW - 5, 2.5);
      ctx.fill();
    } else {
      ctx.fillRect(-carLen / 2 + 5, -carW / 2 + 1.8, carLen - 10, 2);
      ctx.fillRect(-carLen / 2 + 5, carW / 2 - 3.8, carLen - 10, 2);
    }

    ctx.restore();
  }

  ctx.restore(); // exit virtual map space

  // 3. Cinema edge vignette + India Express telemetry HUD
  const vig = ctx.createRadialGradient(w / 2, h / 2, w * 0.24, w / 2, h / 2, h * 0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(4, 8, 16, 0.72)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  if (zoomP < 0.45) {
    const hudAlpha = 1 - zoomP / 0.45;
    const totalKm = Math.max(240, Math.round(distPx * 3.1));
    const currentKm = Math.round(rideP * totalKm);

    ctx.save();
    ctx.globalAlpha = hudAlpha;
    const cardW = w - 84 * s;
    const cardH = 82 * s;
    const cardX = 42 * s;
    const cardY = h - 146 * s;

    ctx.fillStyle = 'rgba(8, 12, 22, 0.8)';
    roundedRectPath(ctx, cardX, cardY, cardW, cardH, 18 * s);
    ctx.fill();
    ctx.strokeStyle = 'rgba(249, 115, 22, 0.32)';
    ctx.lineWidth = 1.5 * s;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `700 ${Math.round(22 * s)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillText(`${fromLabel}  🚆  ${toLabel}`, cardX + 22 * s, cardY + 29 * s);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#FB923C';
    ctx.font = `600 ${Math.round(18 * s)}px "JetBrains Mono", monospace`;
    ctx.fillText(`${currentKm} KM`, cardX + cardW - 22 * s, cardY + 29 * s);

    const barX = cardX + 22 * s;
    const barY = cardY + 56 * s;
    const barW = cardW - 44 * s;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    roundedRectPath(ctx, barX, barY, barW, 6 * s, 3 * s);
    ctx.fill();

    const fillGrad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    fillGrad.addColorStop(0, '#F97316');
    fillGrad.addColorStop(0.55, '#FACC15');
    fillGrad.addColorStop(1, '#22C55E');
    ctx.fillStyle = fillGrad;
    roundedRectPath(ctx, barX, barY, Math.max(8 * s, barW * rideP), 6 * s, 3 * s);
    ctx.fill();
    ctx.restore();
  }

  // 4. Smooth zoom-through arrival right into Clip #1!
  if (zoomP > 0.35 && segments.length > 0) {
    const firstDrawable = resolveDrawable(segments[0].clip);
    if (firstDrawable) {
      const revealP = easeOutCubic((zoomP - 0.35) / 0.65);
      const { fromCanvas, fromCtx } = getTransitionBuffers(w, h);
      fromCtx.fillStyle = '#08080A';
      fromCtx.fillRect(0, 0, w, h);
      drawAutoUniformSlide(
        fromCtx,
        firstDrawable,
        w,
        h,
        0,
        0,
        'contrast(1.1) saturate(1.18)',
        landscapeTilt
      );
      ctx.save();
      ctx.globalAlpha = revealP;
      const inScale = 1.24 - revealP * 0.24;
      ctx.translate(w / 2, h / 2);
      ctx.scale(inScale, inScale);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(fromCanvas, 0, 0, w, h);
      ctx.restore();
    }
  }

  if (zoomP > 0.55) {
    const flashP = (zoomP - 0.55) / 0.45;
    const flashAlpha = Math.sin(flashP * Math.PI) * 0.58;
    ctx.fillStyle = `rgba(255, 237, 213, ${flashAlpha.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
  }

  if (config.watermarkEnabled && config.watermarkText.trim()) {
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = `500 ${Math.round(16 * s)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.56)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 6 * s;
    ctx.fillText(config.watermarkText.trim(), w - 38 * s, 42 * s);
    ctx.restore();
  }
}

function splitCutoutTitleLines(raw: string): string[] {
  const clean = raw.trim().toUpperCase();
  if (!clean) return [];
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= 1 || clean.length <= 7) {
    return [clean];
  }
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

/**
 * Upgraded Marvel Comic Intro & Name Portal Zoom-Through:
 * Uses ultra-bold condensed cinema display lettering, rapid 3D sliding comic-panel page flips (Marvel)
 * or live glowing cutout portal (Name Portal), chromatic zoom-echo trails, and explosive zoom-through.
 */
function renderTextCutoutZoomIntro(
  ctx: CanvasRenderingContext2D,
  timeSec: number,
  introDur: number,
  config: RenderConfig,
  segments: ClipSegment[]
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const s = w / 720;
  const isMarvel = config.template.specialMode === 'marvel-intro';
  const landscapeTilt: LandscapeTilt = config.landscapeTilt ?? 'right';
  const { fromCanvas: bgCanvas, fromCtx: bgCtx, maskCanvas, maskCtx } = getTransitionBuffers(w, h);

  const holdEnd = introDur * 0.68; // ~2.14s build/flip, ~1.01s hyper-zoom breakthrough
  const holdP = clamp01(timeSec / Math.max(0.1, holdEnd));
  const zoomP = clamp01((timeSec - holdEnd) / Math.max(0.1, introDur - holdEnd));

  // 1. Render vibrant live photo/video or rapid Marvel 3D sliding comic-strip panels onto bgCanvas
  bgCtx.fillStyle = '#08080A';
  bgCtx.fillRect(0, 0, w, h);

  if (isMarvel && timeSec < holdEnd && segments.length > 0) {
    const flipRate = 0.095; // crisp rapid comic-book page flip cadence
    const flipStep = Math.floor(timeSec / flipRate);
    const stepFrac = (timeSec % flipRate) / flipRate;
    const curSeg = segments[flipStep % segments.length];
    const prevSeg = segments[(flipStep + segments.length - 1) % segments.length];
    const curDraw = resolveDrawable(curSeg.clip);
    const prevDraw = resolveDrawable(prevSeg.clip) ?? curDraw;

    // 3-panel vertical comic-strip wipe sliding at high momentum
    const slideOffset = (1 - easeOutCubic(stepFrac)) * h * 0.28 * (flipStep % 2 === 0 ? 1 : -1);
    if (prevDraw) {
      bgCtx.save();
      bgCtx.globalAlpha = 0.45;
      drawAutoUniformSlide(
        bgCtx,
        prevDraw,
        w,
        h,
        0.2,
        flipStep,
        'contrast(1.38) saturate(1.48) brightness(1.04)',
        landscapeTilt
      );
      bgCtx.restore();
    }
    if (curDraw) {
      bgCtx.save();
      bgCtx.translate(0, slideOffset);
      drawAutoUniformSlide(
        bgCtx,
        curDraw,
        w,
        h,
        stepFrac * 0.25,
        flipStep,
        'contrast(1.36) saturate(1.52) brightness(1.08)',
        landscapeTilt
      );
      bgCtx.restore();
    }

    // Subtle graphic comic gutter lines flashing horizontally inside the letters
    bgCtx.fillStyle = 'rgba(255, 255, 255, 0.24)';
    const gutterY = ((flipStep * 137) % Math.round(h * 0.6)) + h * 0.2;
    bgCtx.fillRect(0, gutterY, w, 4 * s);
  } else if (segments.length > 0) {
    const clipIdx =
      !isMarvel && timeSec < holdEnd && segments.length > 1
        ? Math.floor(timeSec / 0.55) % segments.length
        : 0;
    const bgDrawable = resolveDrawable(segments[clipIdx]?.clip ?? segments[0].clip);
    if (bgDrawable) {
      const filter = isMarvel
        ? 'contrast(1.26) saturate(1.38) brightness(1.06)'
        : 'contrast(1.22) saturate(1.28) brightness(1.06)';
      drawAutoUniformSlide(
        bgCtx,
        bgDrawable,
        w,
        h,
        clamp01(timeSec / introDur),
        clipIdx,
        filter,
        landscapeTilt
      );
    }
  }

  // 2. Massive condensed theatrical display typography (tall Impact/Marvel proportions!)
  const lines = splitCutoutTitleLines(config.title);
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
  const condenseX = 0.74; // iconic tall condensed cinema look
  const baseFontPx = Math.min(
    lines.length > 1 ? 186 * s : 228 * s,
    Math.max(96 * s, (w * 0.9) / Math.max(2.2, longest * 0.62 * condenseX))
  );
  const fontSpec = `900 ${Math.round(baseFontPx)}px Impact, "Arial Black", "Plus Jakarta Sans", sans-serif`;
  const lineH = baseFontPx * 0.92;

  // Marvel pulls back dramatically then punches forward; Name Portal slowly glides in then rockets through
  const zoomScale =
    zoomP <= 0
      ? isMarvel
        ? 1.32 - easeOutCubic(Math.min(1, holdP * 1.45)) * 0.3 + holdP * 0.08
        : 0.88 + easeOutCubic(holdP) * 0.22
      : (isMarvel ? 1.1 : 1.1) + easeInExpo(zoomP) * 42;

  const subtleTilt = zoomP <= 0 && !isMarvel ? Math.sin(timeSec * 1.8) * 0.018 : 0;

  const drawTextLines = (target: CanvasRenderingContext2D, mode: 'fill' | 'stroke') => {
    lines.forEach((line, idx) => {
      const yOff = (idx - (lines.length - 1) / 2) * lineH;
      if (mode === 'fill') target.fillText(line, 0, yOff);
      else target.strokeText(line, 0, yOff);
    });
  };

  // 3. Build transparent-letter cutout mask filled with live background video/comic flips
  maskCtx.clearRect(0, 0, w, h);
  maskCtx.save();
  maskCtx.globalCompositeOperation = 'source-over';
  maskCtx.translate(w / 2, h / 2);
  maskCtx.rotate(subtleTilt);
  maskCtx.scale(zoomScale * condenseX, zoomScale);
  maskCtx.fillStyle = '#FFFFFF';
  maskCtx.textAlign = 'center';
  maskCtx.textBaseline = 'middle';
  maskCtx.font = fontSpec;
  drawTextLines(maskCtx, 'fill');
  maskCtx.restore();

  maskCtx.save();
  maskCtx.globalCompositeOperation = 'source-in';
  maskCtx.drawImage(bgCanvas, 0, 0, w, h);
  maskCtx.restore();

  // 4. Draw theatrical backdrop
  if (isMarvel) {
    // Rich iconic Marvel Studios crimson radial plate with animated comic texture bleed
    const redGrad = ctx.createRadialGradient(w / 2, h / 2, w * 0.05, w / 2, h / 2, h * 0.74);
    redGrad.addColorStop(0, '#DC2626');
    redGrad.addColorStop(0.52, '#7F1D1D');
    redGrad.addColorStop(1, '#09090B');
    ctx.fillStyle = redGrad;
    ctx.fillRect(0, 0, w, h);

    // Subtle ghostly rapid comic page bleed behind the crimson studio wall
    ctx.save();
    ctx.globalAlpha = 0.22 * (1 - zoomP * 0.85);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(bgCanvas, 0, 0, w, h);
    ctx.restore();

    // Classic Marvel top/bottom studio bar framing the title plate
    if (zoomP < 0.35) {
      const barAlpha = (1 - zoomP / 0.35) * 0.82;
      const boxHalfH = (lines.length * lineH * zoomScale) / 2 + 24 * s;
      const boxW = Math.min(w * 0.9, w * 0.78 * zoomScale);
      ctx.save();
      ctx.fillStyle = `rgba(255, 255, 255, ${barAlpha.toFixed(3)})`;
      ctx.fillRect(w / 2 - boxW / 2, h / 2 - boxHalfH - 5 * s, boxW, 4.5 * s);
      ctx.fillRect(w / 2 - boxW / 2, h / 2 + boxHalfH, boxW, 4.5 * s);
      ctx.restore();
    }
  } else {
    // Deep obsidian portal with subtle live ambient light bleeding behind the letters
    ctx.fillStyle = '#040406';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalAlpha = 0.26 * (1 - zoomP * 0.6);
    ctx.filter = `blur(${Math.round(36 * s)}px) saturate(1.4)`;
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.restore();
  }

  // 5. Multi-layer chromatic zoom-echo outlines during breakthrough (gives real After Effects 3D depth!)
  if (zoomP > 0.03 && zoomP < 0.75) {
    const echoStrength = Math.sin(clamp01(zoomP / 0.75) * Math.PI);
    const echoSpecs: [number, string][] = isMarvel
      ? [
          [1.14, `rgba(254, 202, 202, ${(echoStrength * 0.38).toFixed(3)})`],
          [1.32, `rgba(239, 68, 68, ${(echoStrength * 0.28).toFixed(3)})`],
        ]
      : [
          [1.14, `rgba(56, 189, 248, ${(echoStrength * 0.34).toFixed(3)})`],
          [1.3, `rgba(244, 63, 94, ${(echoStrength * 0.26).toFixed(3)})`],
        ];
    for (const [mult, strokeColor] of echoSpecs) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(subtleTilt);
      ctx.scale(zoomScale * mult * condenseX, zoomScale * mult);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = fontSpec;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.max(1.5, 2.8 * s);
      drawTextLines(ctx, 'stroke');
      ctx.restore();
    }
  }

  // 6. Composite the sharp live cutout text
  ctx.drawImage(maskCanvas, 0, 0, w, h);

  // Razor-sharp metallic white rim around letters during hold phase
  if (zoomP < 0.38) {
    const strokeAlpha = (1 - zoomP / 0.38) * (isMarvel ? 0.92 : 0.68);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(subtleTilt);
    ctx.scale(zoomScale * condenseX, zoomScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = fontSpec;
    ctx.strokeStyle = isMarvel
      ? `rgba(255, 255, 255, ${strokeAlpha.toFixed(3)})`
      : `rgba(244, 244, 245, ${strokeAlpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(1.5, 3.2 * s);
    drawTextLines(ctx, 'stroke');
    ctx.restore();
  }

  // Optional subtitle beneath the giant cutout name (only if user typed one)
  if (config.subtitle.trim() && zoomP < 0.24) {
    ctx.save();
    ctx.globalAlpha = 1 - zoomP / 0.24;
    ctx.textAlign = 'center';
    ctx.fillStyle = isMarvel ? 'rgba(254, 226, 226, 0.92)' : 'rgba(212, 212, 216, 0.85)';
    ctx.font = `600 ${Math.round(20 * s)}px "JetBrains Mono", monospace`;
    ctx.fillText(
      config.subtitle.trim().toUpperCase(),
      w / 2,
      h / 2 + (lines.length * lineH * zoomScale) / 2 + 52 * s
    );
    ctx.restore();
  }

  // 7. Seamless breakthrough into full-bleed first clip as the camera flies straight through the letters
  if (zoomP > 0.48) {
    const revealAlpha = easeOutCubic((zoomP - 0.48) / 0.52);
    ctx.save();
    ctx.globalAlpha = revealAlpha;
    const punchScale = 1.18 - revealAlpha * 0.18;
    ctx.translate(w / 2, h / 2);
    ctx.scale(punchScale, punchScale);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(bgCanvas, 0, 0, w, h);
    ctx.restore();
  }

  // Dramatic white flash peak right as you pass through the text portal
  if (zoomP > 0.62) {
    const flashP = (zoomP - 0.62) / 0.38;
    const flashAlpha = Math.sin(flashP * Math.PI) * 0.78;
    ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
  }

  if (config.watermarkEnabled && config.watermarkText.trim()) {
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = `500 ${Math.round(16 * s)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.56)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 6 * s;
    ctx.fillText(config.watermarkText.trim(), w - 38 * s, 42 * s);
    ctx.restore();
  }
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

  // Special Mode 1: Real-time Green Screen Chroma Key Compositor
  if (template.specialMode === 'chroma-green-screen') {
    renderGreenScreenChromaFrame(ctx, timeSec, config);
    return;
  }

  const { introDur, segments } = getClipTimeline(config);
  if (segments.length === 0) return;

  // Special Mode 2: Viral VN Diagonal Mirror-Mask Shadow Reveal
  if (template.specialMode === 'vn-shadow-reveal') {
    renderVnShadowRevealFrame(ctx, timeSec, config, segments);
    return;
  }

  // Special Mode 3: Animated 3D Travel Map Route & India Train Map Intros
  if (introDur > 0 && timeSec < introDur && template.specialMode === 'map-route-zoom') {
    renderMapRouteIntroFrame(ctx, timeSec, introDur, config, segments);
    return;
  }

  if (introDur > 0 && timeSec < introDur && template.specialMode === 'india-train-map') {
    renderIndiaTrainMapIntroFrame(ctx, timeSec, introDur, config, segments);
    return;
  }

  // Special Mode 4: Marvel Comic Flip Intro & Name Portal Transparent-Text Zoom-Through
  if (
    introDur > 0 &&
    timeSec < introDur &&
    (template.specialMode === 'marvel-intro' || template.specialMode === 'text-portal')
  ) {
    renderTextCutoutZoomIntro(ctx, timeSec, introDur, config, segments);
    return;
  }

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

  // Keep intro-only titles strictly in the intro (don't stamp them again at bottom during clips)
  const isIntroOnlyTitle =
    template.specialMode === 'marvel-intro' ||
    template.specialMode === 'text-portal' ||
    template.specialMode === 'map-route-zoom' ||
    template.specialMode === 'india-train-map';
  const clipTitle = isIntroOnlyTitle ? '' : title;
  const clipSub = isIntroOnlyTitle ? '' : subtitle;

  if (inTransition) {
    const tRaw = clamp01((localTime - (seg.durationSec - transDur)) / transDur);
    const nextImg = resolveDrawable(nextSeg.clip) ?? curImg;
    const nextPartner = resolveDrawable(segments[(nextIdx + 1) % count].clip);

    const { fromCanvas, fromCtx, toCanvas, toCtx } = getTransitionBuffers(w, h);
    drawStyledSlide(fromCtx, curImg, partnerImg, w, h, slideProgress, slideIdx, template, clipTitle, clipSub, landscapeTilt);
    drawStyledSlide(toCtx, nextImg, nextPartner, w, h, tRaw * 0.15, nextIdx, template, clipTitle, clipSub, landscapeTilt);

    renderInShotTransition(ctx, fromCanvas, toCanvas, w, h, tRaw, activeTransition, slideIdx);
  } else {
    drawStyledSlide(ctx, curImg, partnerImg, w, h, slideProgress, slideIdx, template, clipTitle, clipSub, landscapeTilt);
  }

  drawColorGradeTint(ctx, template, w, h, timeSec);

  // Subtle sleek top-left route stamp during clips for Map Route / India Train Map (only if user kept route text)
  if (
    (template.specialMode === 'map-route-zoom' || template.specialMode === 'india-train-map') &&
    (title.trim() || subtitle.trim())
  ) {
    const isTrain = template.specialMode === 'india-train-map';
    const icon = isTrain ? '🚆' : '✈';
    const routeText =
      title.trim() && subtitle.trim()
        ? `${title.trim().toUpperCase()} ${icon} ${subtitle.trim().toUpperCase()}`
        : (title.trim() || subtitle.trim()).toUpperCase();
    ctx.save();
    ctx.font = `700 ${Math.round(17 * s)}px "JetBrains Mono", monospace`;
    const tw = ctx.measureText(routeText).width;
    const bx = 34 * s;
    const by = 40 * s;
    const bw = tw + 28 * s;
    const bh = 36 * s;
    ctx.fillStyle = 'rgba(6, 13, 24, 0.68)';
    roundedRectPath(ctx, bx, by, bw, bh, 10 * s);
    ctx.fill();
    ctx.strokeStyle = isTrain ? 'rgba(251, 146, 60, 0.45)' : 'rgba(125, 211, 252, 0.35)';
    ctx.lineWidth = 1.2 * s;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(routeText, bx + 14 * s, by + bh / 2 + 0.5 * s);
    ctx.restore();
  }

  drawTemplateOverlay(ctx, w, h, timeSec, {
    ...config,
    title: clipTitle,
    subtitle: clipSub,
  });
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
