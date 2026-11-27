import { useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, RotateCcw, X } from 'lucide-react';
import { LandscapeTilt, PaceMode, ReelTemplate, TransitionChoice } from '../data/templates';
import {
  FrameImage,
  getActiveVideoTargets,
  getTotalDuration,
  isVideoElement,
  RenderClip,
  renderFrame,
  RenderConfig,
  seekVideoToTime,
} from '../lib/videoRenderer';

interface VideoPreviewStageProps {
  template: ReelTemplate;
  images: FrameImage[];
  clips?: RenderClip[];
  title: string;
  subtitle: string;
  pace: PaceMode;
  landscapeTilt?: LandscapeTilt;
  transitionOverride?: TransitionChoice;
  chromaSensitivity?: number;
  presetOverlayClip?: RenderClip | null;
  watermarkEnabled: boolean;
  watermarkText: string;
  isExporting: boolean;
  pausePlayback?: boolean;
  fillViewport?: boolean;
  scrubRequest?: { timeSec: number; nonce: number } | null;
}

export function VideoPreviewStage({
  template,
  images,
  clips,
  title,
  subtitle,
  pace,
  landscapeTilt = 'right',
  transitionOverride = 'auto',
  chromaSensitivity = 0.55,
  presetOverlayClip = null,
  watermarkEnabled,
  watermarkText,
  isExporting,
  pausePlayback = false,
  fillViewport = false,
  scrubRequest = null,
}: VideoPreviewStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fullCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const timeRef = useRef(0);
  const lastScrubNonceRef = useRef(-1);
  const configRef = useRef<RenderConfig>({
    template,
    images,
    clips,
    title,
    subtitle,
    pace,
    landscapeTilt,
    transitionOverride,
    chromaSensitivity,
    presetOverlayClip,
    watermarkEnabled,
    watermarkText,
  });

  configRef.current = {
    template,
    images,
    clips,
    title,
    subtitle,
    pace,
    landscapeTilt,
    transitionOverride,
    chromaSensitivity,
    presetOverlayClip,
    watermarkEnabled,
    watermarkText,
  };

  const totalDuration = getTotalDuration(configRef.current);

  const pauseAllVideos = (cfg: RenderConfig) => {
    const all: RenderClip[] = [...(cfg.clips || [])];
    if (cfg.presetOverlayClip) all.push(cfg.presetOverlayClip);
    for (const c of all) {
      if (c.kind === 'video' && isVideoElement(c.source) && !c.source.paused) {
        try {
          c.source.pause();
        } catch {
          // ignore
        }
      }
    }
  };

  const syncVideosForTime = (t: number, cfg: RenderConfig, shouldPlay: boolean) => {
    const hasClips = Boolean(cfg.clips && cfg.clips.length > 0);
    if (!hasClips && !cfg.presetOverlayClip) return;
    const targets = getActiveVideoTargets(t, cfg);
    const activeSet = new Set(targets.map((item) => item.video));

    const all: RenderClip[] = [...(cfg.clips || [])];
    if (cfg.presetOverlayClip) all.push(cfg.presetOverlayClip);
    for (const c of all) {
      if (c.kind === 'video' && isVideoElement(c.source) && !activeSet.has(c.source)) {
        if (!c.source.paused) {
          try {
            c.source.pause();
          } catch {
            // ignore
          }
        }
      }
    }

    for (const target of targets) {
      const vid = target.video;
      if (shouldPlay) {
        if (Math.abs(vid.currentTime - target.targetTime) > 0.28) {
          try {
            vid.currentTime = target.targetTime;
          } catch {
            // ignore
          }
        }
        if (vid.paused) {
          void vid.play().catch(() => {});
        }
      } else {
        if (!vid.paused) {
          try {
            vid.pause();
          } catch {
            // ignore
          }
        }
        if (Math.abs(vid.currentTime - target.targetTime) > 0.04) {
          try {
            vid.currentTime = target.targetTime;
          } catch {
            // ignore
          }
        }
      }
    }
  };

  // Allow Trim/Cut sliders to scrub the live preview straight to a specific frame
  useEffect(() => {
    if (!scrubRequest || scrubRequest.nonce === lastScrubNonceRef.current) return;
    lastScrubNonceRef.current = scrubRequest.nonce;
    const dur = getTotalDuration(configRef.current);
    const clamped = Math.max(0, Math.min(scrubRequest.timeSec, Math.max(0, dur - 0.02)));
    setIsPlaying(false);
    timeRef.current = clamped;
    setCurrentTime(clamped);

    const targets = getActiveVideoTargets(clamped, configRef.current);
    pauseAllVideos(configRef.current);
    if (targets.length > 0) {
      void Promise.all(targets.map((t) => seekVideoToTime(t.video, t.targetTime))).then(() => {
        const activeCanvas = isFullscreen ? fullCanvasRef.current : canvasRef.current;
        const ctx = activeCanvas?.getContext('2d');
        if (ctx) {
          renderFrame(ctx, clamped, configRef.current);
        }
      });
    } else {
      const activeCanvas = isFullscreen ? fullCanvasRef.current : canvasRef.current;
      const ctx = activeCanvas?.getContext('2d');
      if (ctx) {
        renderFrame(ctx, clamped, configRef.current);
      }
    }
  }, [scrubRequest, isFullscreen]);

  useEffect(() => {
    let raf = 0;
    let lastMs = performance.now();
    let lastUi = 0;

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - lastMs) / 1000);
      lastMs = now;
      const cfg = configRef.current;
      const dur = getTotalDuration(cfg);
      const activePlaying = isPlaying && !isExporting && !pausePlayback;

      if (activePlaying) {
        timeRef.current = (timeRef.current + dt) % dur;
      } else if (timeRef.current >= dur) {
        timeRef.current = 0;
      }

      if (!isExporting) {
        if (pausePlayback) {
          pauseAllVideos(cfg);
        } else {
          syncVideosForTime(timeRef.current, cfg, activePlaying);
        }
      }

      const activeCanvas = isFullscreen ? fullCanvasRef.current : canvasRef.current;
      const ctx = activeCanvas?.getContext('2d');
      if (ctx) {
        renderFrame(ctx, timeRef.current, cfg);
      }

      if (now - lastUi > 100) {
        lastUi = now;
        setCurrentTime(timeRef.current);
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      pauseAllVideos(configRef.current);
    };
  }, [isPlaying, isExporting, pausePlayback, isFullscreen]);

  const handleRestart = () => {
    timeRef.current = 0;
    setCurrentTime(0);
    setIsPlaying(true);
  };

  const handleSeek = (val: number) => {
    timeRef.current = val;
    setCurrentTime(val);
    const cfg = configRef.current;
    const targets = getActiveVideoTargets(val, cfg);
    if (targets.length > 0 && !isPlaying) {
      void Promise.all(targets.map((t) => seekVideoToTime(t.video, t.targetTime))).then(() => {
        const activeCanvas = isFullscreen ? fullCanvasRef.current : canvasRef.current;
        const ctx = activeCanvas?.getContext('2d');
        if (ctx) {
          renderFrame(ctx, val, cfg);
        }
      });
    } else {
      syncVideosForTime(val, cfg, isPlaying && !isExporting && !pausePlayback);
      const activeCanvas = isFullscreen ? fullCanvasRef.current : canvasRef.current;
      const ctx = activeCanvas?.getContext('2d');
      if (ctx) {
        renderFrame(ctx, val, cfg);
      }
    }
  };

  const formatTime = (sec: number) => {
    const s = Math.floor(sec);
    const tenths = Math.floor((sec - s) * 10);
    return `${String(s).padStart(2, '0')}.${tenths}s`;
  };

  return (
    <>
      <div
        className={`flex flex-col items-center justify-center ${
          fillViewport ? 'h-full w-full min-h-0' : 'w-full'
        }`}
      >
        {/* 9:16 Video Frame — auto-scales to fit viewport cleanly without ever needing scroll */}
        <div
          className={`relative overflow-hidden rounded-[22px] bg-[#0B0B0E] border border-white/15 shadow-2xl shadow-black/70 aspect-[9/16] ${
            fillViewport
              ? 'h-full max-h-[calc(100%-56px)] w-auto max-w-full'
              : 'w-full max-w-[300px]'
          }`}
        >
          <canvas
            ref={canvasRef}
            width={540}
            height={960}
            onClick={() => setIsPlaying((p) => !p)}
            className="h-full w-full block object-cover cursor-pointer"
            aria-label="Live 9:16 vertical status video preview"
          />

          <button
            type="button"
            onClick={() => setIsFullscreen(true)}
            aria-label="Full-screen preview"
            className="absolute top-2.5 left-2.5 min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl bg-black/55 backdrop-blur-md border border-white/15 text-white hover:bg-black/80 transition"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>

        {/* Compact Transport Bar right under the video */}
        <div className="mt-2.5 w-full max-w-[320px] flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setIsPlaying((p) => !p)}
            aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl bg-white/[0.06] border border-white/10 text-white hover:bg-white/[0.12] transition shrink-0"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>

          <button
            type="button"
            onClick={handleRestart}
            aria-label="Restart preview"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl bg-white/[0.06] border border-white/10 text-zinc-300 hover:text-white hover:bg-white/[0.12] transition shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <input
            type="range"
            min={0}
            max={Math.max(0.1, totalDuration - 0.05)}
            step={0.05}
            value={Math.min(currentTime, totalDuration)}
            onChange={(e) => handleSeek(Number(e.target.value))}
            aria-label="Seek timeline"
            className="flex-1 accent-white h-1.5 cursor-pointer"
          />

          <span className="text-[11px] font-mono text-zinc-400 tabular-nums shrink-0">
            {formatTime(currentTime)}/{formatTime(totalDuration)}
          </span>
        </div>
      </div>

      {/* True Full-Screen 9:16 Modal Preview */}
      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 bg-[#050507]/95 backdrop-blur-md flex flex-col items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Full-screen 9:16 preview"
        >
          <button
            type="button"
            onClick={() => setIsFullscreen(false)}
            aria-label="Close full-screen preview"
            className="absolute top-4 right-4 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-white/10 border border-white/15 text-white hover:bg-white/20 transition"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="relative h-[80vh] max-w-full aspect-[9/16] rounded-[24px] overflow-hidden border border-white/15 shadow-2xl">
            <canvas
              ref={fullCanvasRef}
              width={720}
              height={1280}
              className="h-full w-full block object-cover"
            />
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsPlaying((p) => !p)}
              className="min-h-[44px] px-5 py-2 rounded-xl bg-white text-[#08080A] text-xs font-semibold flex items-center gap-2"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              <span>{isPlaying ? 'Pause' : 'Play'}</span>
            </button>
            <button
              type="button"
              onClick={handleRestart}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-white/10 border border-white/15 text-white text-xs font-medium"
            >
              Restart
            </button>
          </div>
        </div>
      )}
    </>
  );
}
