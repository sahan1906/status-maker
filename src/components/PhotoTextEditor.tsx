import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Film,
  Gauge,
  ImagePlus,
  Images,
  Loader2,
  RotateCcw,
  RotateCw,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Video,
  X,
} from 'lucide-react';
import {
  LandscapeTilt,
  PaceMode,
  ReelTemplate,
  TRANSITION_PRESETS,
  TransitionChoice,
} from '../data/templates';
import { getSlideDuration } from '../lib/videoRenderer';

export interface GalleryPhoto {
  id: string;
  kind: 'photo' | 'video';
  previewUrl: string;
  videoUrl?: string;
  name: string;
  isSample?: boolean;
  sourceDuration?: number;
  trimStart?: number;
  trimEnd?: number;
}

type EditorTool = 'photos' | 'trim' | 'transition' | 'text' | 'speed';

interface PhotoTextEditorProps {
  template: ReelTemplate;
  photos: GalleryPhoto[];
  title: string;
  subtitle: string;
  pace: PaceMode;
  landscapeTilt: LandscapeTilt;
  transitionChoice: TransitionChoice;
  isLoadingMedia?: boolean;
  mediaError?: string | null;
  onAddPhotos: (files: FileList) => void;
  onAddVideos: (files: FileList) => void;
  onRemovePhoto: (id: string) => void;
  onMovePhoto: (fromIdx: number, toIdx: number) => void;
  onTrimClip: (id: string, trimStart: number, trimEnd: number) => void;
  onSplitClip: (id: string, splitAtSourceSec: number) => string | null;
  onScrubClipTime: (clipId: string, sourceTimeSec: number) => void;
  onResetSamples: () => void;
  onTitleChange: (val: string) => void;
  onSubtitleChange: (val: string) => void;
  onPaceChange: (pace: PaceMode) => void;
  onLandscapeTiltChange: (tilt: LandscapeTilt) => void;
  onTransitionChange: (choice: TransitionChoice) => void;
}

const PACE_OPTIONS: { id: PaceMode; label: string; desc: string }[] = [
  { id: 'fast', label: 'Fast', desc: 'Snappy Reels rhythm' },
  { id: 'normal', label: 'Normal', desc: 'Balanced flow' },
  { id: 'slow', label: 'Slow', desc: 'Cinematic linger' },
];

const TOOL_TABS: { id: EditorTool; label: string; icon: typeof Images }[] = [
  { id: 'photos', label: 'Clips', icon: Images },
  { id: 'trim', label: 'Trim/Cut', icon: Scissors },
  { id: 'transition', label: 'FX', icon: Sparkles },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'speed', label: 'Speed', icon: Gauge },
];

const MIN_VIDEO_CLIP_SEC = 0.3;

function formatSec(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  if (mins > 0) {
    return `${mins}:${rem < 10 ? '0' : ''}${rem.toFixed(1)}`;
  }
  return `${rem.toFixed(1)}s`;
}

export function PhotoTextEditor({
  template,
  photos,
  title,
  subtitle,
  pace,
  landscapeTilt,
  transitionChoice,
  isLoadingMedia = false,
  mediaError = null,
  onAddPhotos,
  onAddVideos,
  onRemovePhoto,
  onMovePhoto,
  onTrimClip,
  onSplitClip,
  onScrubClipTime,
  onResetSamples,
  onTitleChange,
  onSubtitleChange,
  onPaceChange,
  onLandscapeTiltChange,
  onTransitionChange,
}: PhotoTextEditorProps) {
  const [activeTool, setActiveTool] = useState<EditorTool>('photos');
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [splitPointSec, setSplitPointSec] = useState<number>(0);
  const [splitFeedback, setSplitFeedback] = useState<string | null>(null);

  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);

  const hasOnlySamples = photos.every((p) => p.isSample);
  const slideSec = getSlideDuration(template, pace);
  const estTotal = Number(
    (
      photos.reduce((acc, clip) => {
        if (clip.kind === 'video') {
          const start = clip.trimStart ?? 0;
          const end = clip.trimEnd ?? clip.sourceDuration ?? 3;
          return acc + Math.max(MIN_VIDEO_CLIP_SEC, end - start);
        }
        return acc + slideSec;
      }, 0) + (template.overlay === 'kinetic-intro' && (title.trim() || subtitle.trim()) ? 1.0 : 0)
    ).toFixed(1)
  );

  const selectedIndex = photos.findIndex((p) => p.id === selectedPhotoId);
  const activeIdx = selectedIndex >= 0 ? selectedIndex : 0;
  const activeClip = photos[activeIdx];
  const videoClips = photos
    .map((clip, idx) => ({ clip, idx }))
    .filter((item) => item.clip.kind === 'video');

  // Keep split point centered safely inside the selected video clip whenever selection or trim range changes
  useEffect(() => {
    if (!activeClip || activeClip.kind !== 'video') return;
    const start = activeClip.trimStart ?? 0;
    const end = activeClip.trimEnd ?? activeClip.sourceDuration ?? 3;
    const minSplit = start + MIN_VIDEO_CLIP_SEC;
    const maxSplit = end - MIN_VIDEO_CLIP_SEC;
    setSplitPointSec((prev) => {
      if (maxSplit <= minSplit) return Number(((start + end) / 2).toFixed(2));
      if (prev >= minSplit && prev <= maxSplit) return prev;
      return Number(((start + end) / 2).toFixed(2));
    });
  }, [activeClip?.id, activeClip?.trimStart, activeClip?.trimEnd, activeClip?.sourceDuration, activeClip?.kind]);

  useEffect(() => {
    if (!splitFeedback) return;
    const t = window.setTimeout(() => setSplitFeedback(null), 3200);
    return () => window.clearTimeout(t);
  }, [splitFeedback]);

  const handlePhotoFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddPhotos(e.target.files);
      e.target.value = '';
    }
  };

  const handleVideoFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddVideos(e.target.files);
      e.target.value = '';
    }
  };

  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => e.preventDefault();
  const handleDrop = (targetIdx: number) => {
    if (dragIdx !== null && dragIdx !== targetIdx) {
      onMovePhoto(dragIdx, targetIdx);
    }
    setDragIdx(null);
  };

  const activeTransitionLabel =
    transitionChoice === 'auto'
      ? `Auto · ${TRANSITION_PRESETS.find((t) => t.id === template.transition)?.label || template.transition}`
      : TRANSITION_PRESETS.find((t) => t.id === transitionChoice)?.label || transitionChoice;

  const activeVideoDuration =
    activeClip?.kind === 'video' ? Math.max(0.4, activeClip.sourceDuration ?? 5) : 0;
  const activeTrimStart = activeClip?.kind === 'video' ? activeClip.trimStart ?? 0 : 0;
  const activeTrimEnd =
    activeClip?.kind === 'video' ? activeClip.trimEnd ?? activeVideoDuration : 0;
  const activeTrimLen = Math.max(MIN_VIDEO_CLIP_SEC, activeTrimEnd - activeTrimStart);
  const canSplitActive = activeTrimLen >= MIN_VIDEO_CLIP_SEC * 2 + 0.05;

  const handleSplitAction = () => {
    if (!activeClip || activeClip.kind !== 'video' || !canSplitActive) return;
    const clampedSplit = Math.max(
      activeTrimStart + MIN_VIDEO_CLIP_SEC,
      Math.min(splitPointSec, activeTrimEnd - MIN_VIDEO_CLIP_SEC)
    );
    const newClipId = onSplitClip(activeClip.id, Number(clampedSplit.toFixed(2)));
    if (newClipId) {
      setSelectedPhotoId(newClipId);
      setSplitFeedback('Split into 2 clips — tap Delete on any part to cut it out.');
    }
  };

  return (
    <div className="flex flex-col bg-[#101013] border-t lg:border border-white/10 lg:rounded-3xl overflow-hidden">
      {/* Separate Photo & Video pickers so mobile/Telegram opens native galleries directly */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handlePhotoFileChange}
        className="sr-only"
        aria-label="Pick up to 50 photos from gallery"
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        onChange={handleVideoFileChange}
        className="sr-only"
        aria-label="Pick video clips from gallery"
      />

      {/* CapCut / InShot Tool Selector Row */}
      <div
        role="tablist"
        aria-label="Edit tools"
        className="grid grid-cols-5 border-b border-white/10 bg-[#0C0C0F]"
      >
        {TOOL_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTool === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTool(tab.id)}
              className={`min-h-[48px] flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 px-1.5 py-2 text-[10px] sm:text-xs font-semibold transition border-b-2 whitespace-nowrap ${
                active
                  ? 'border-white text-white bg-white/[0.04]'
                  : 'border-transparent text-zinc-500 hover:text-zinc-200'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Compact Active Tool Tray */}
      <div className="p-3.5 sm:p-5 min-h-[164px] lg:min-h-[268px] flex flex-col justify-center">
        {mediaError && (
          <div className="mb-2.5 rounded-xl bg-red-500/10 border border-red-500/25 px-3 py-2 text-[11px] text-red-200">
            {mediaError}
          </div>
        )}

        {/* 1. CLIPS FILMSTRIP TRAY (Photos + Videos) */}
        {activeTool === 'photos' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] sm:text-xs text-zinc-400 font-mono tabular-nums truncate">
                {isLoadingMedia
                  ? 'Loading media...'
                  : hasOnlySamples
                  ? 'Sample · Add photos or videos'
                  : `${photos.length}/50 clips · ${estTotal}s`}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                {activeClip?.kind === 'video' && (
                  <button
                    type="button"
                    onClick={() => setActiveTool('trim')}
                    className="min-h-[32px] px-2.5 text-[11px] font-semibold rounded-lg bg-amber-400 text-[#08080A] hover:bg-amber-300 flex items-center gap-1 transition whitespace-nowrap"
                  >
                    <Scissors className="w-3 h-3" />
                    <span>Trim / Cut</span>
                  </button>
                )}
                {!hasOnlySamples && (
                  <button
                    type="button"
                    onClick={onResetSamples}
                    className="min-h-[32px] px-2 text-[11px] font-medium rounded-lg bg-white/[0.05] border border-white/10 text-zinc-300 hover:text-white flex items-center gap-1 transition whitespace-nowrap"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span className="hidden sm:inline">Reset</span>
                  </button>
                )}
                {photos.length > 1 && activeClip && (
                  <div className="flex items-center gap-0.5 bg-white/[0.04] border border-white/10 rounded-lg p-0.5">
                    <button
                      type="button"
                      onClick={() => onMovePhoto(activeIdx, activeIdx - 1)}
                      disabled={activeIdx <= 0}
                      aria-label="Move selected clip earlier"
                      className="min-h-[28px] min-w-[28px] flex items-center justify-center rounded-md text-zinc-300 hover:bg-white/10 disabled:opacity-25 transition"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMovePhoto(activeIdx, activeIdx + 1)}
                      disabled={activeIdx >= photos.length - 1}
                      aria-label="Move selected clip later"
                      className="min-h-[28px] min-w-[28px] flex items-center justify-center rounded-md text-zinc-300 hover:bg-white/10 disabled:opacity-25 transition"
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemovePhoto(activeClip.id)}
                      aria-label="Remove selected clip"
                      className="min-h-[28px] min-w-[28px] flex items-center justify-center rounded-md text-zinc-300 hover:text-red-400 hover:bg-red-500/15 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Horizontal scrollable filmstrip with dedicated + Photo and + Video buttons */}
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={isLoadingMedia || (!hasOnlySamples && photos.length >= 50)}
                className="shrink-0 w-[68px] h-[94px] rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 disabled:opacity-40 flex flex-col items-center justify-center gap-1 transition"
              >
                <ImagePlus className="w-4 h-4" />
                <span className="text-[10px] font-bold">+ Photo</span>
              </button>

              <button
                type="button"
                onClick={() => videoInputRef.current?.click()}
                disabled={isLoadingMedia || (!hasOnlySamples && photos.length >= 50)}
                className="shrink-0 w-[68px] h-[94px] rounded-xl bg-amber-400/15 text-amber-200 border border-amber-400/40 hover:bg-amber-400/25 disabled:opacity-40 flex flex-col items-center justify-center gap-1 transition"
              >
                {isLoadingMedia ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Video className="w-4 h-4" />
                )}
                <span className="text-[10px] font-bold">+ Video</span>
              </button>

              {photos.map((photo, idx) => {
                const isSelected = idx === activeIdx;
                const clipLen =
                  photo.kind === 'video'
                    ? Math.max(
                        MIN_VIDEO_CLIP_SEC,
                        (photo.trimEnd ?? photo.sourceDuration ?? 3) - (photo.trimStart ?? 0)
                      )
                    : null;
                return (
                  <div
                    key={photo.id}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={handleDragOver}
                    onDrop={() => handleDrop(idx)}
                    onDragEnd={() => setDragIdx(null)}
                    onClick={() => setSelectedPhotoId(photo.id)}
                    className={`relative shrink-0 w-[68px] h-[94px] rounded-xl overflow-hidden cursor-pointer border-2 transition ${
                      dragIdx === idx
                        ? 'opacity-50 border-white/60'
                        : isSelected
                        ? 'border-white ring-2 ring-white/25'
                        : 'border-white/10 hover:border-white/30'
                    }`}
                  >
                    <img
                      src={photo.previewUrl}
                      alt={`Clip ${idx + 1}`}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/75 text-[10px] font-mono text-white tabular-nums">
                      {idx + 1}
                    </span>
                    {photo.kind === 'video' && clipLen !== null && (
                      <span className="absolute bottom-1 left-1 right-1 px-1 py-0.5 rounded bg-black/80 text-[9px] font-mono text-amber-300 flex items-center justify-center gap-0.5 tabular-nums">
                        <Film className="w-2.5 h-2.5 shrink-0" />
                        <span>{formatSec(clipLen)}</span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2. VIDEO TRIM & CUT (SPLIT) TRAY */}
        {activeTool === 'trim' && (
          <div className="space-y-3">
            {activeClip?.kind === 'video' ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-200 text-[10px] font-mono shrink-0">
                      Clip #{activeIdx + 1}
                    </span>
                    <span className="text-xs font-mono text-zinc-200 tabular-nums truncate">
                      {formatSec(activeTrimLen)}{' '}
                      <span className="text-zinc-500">/ {formatSec(activeVideoDuration)}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {(activeTrimStart > 0.05 || activeTrimEnd < activeVideoDuration - 0.05) && (
                      <button
                        type="button"
                        onClick={() => {
                          onTrimClip(activeClip.id, 0, activeVideoDuration);
                          onScrubClipTime(activeClip.id, 0);
                        }}
                        className="min-h-[30px] px-2 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] text-zinc-300 hover:text-white flex items-center gap-1 transition"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Full</span>
                      </button>
                    )}
                    {photos.length > 1 && (
                      <button
                        type="button"
                        onClick={() => onRemovePhoto(activeClip.id)}
                        className="min-h-[30px] px-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[11px] text-red-300 hover:bg-red-500/20 flex items-center gap-1 transition"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Visual timeline bar showing kept trim range + split marker */}
                <div className="relative h-2.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="absolute top-0 bottom-0 bg-amber-400/80 rounded-full"
                    style={{
                      left: `${(activeTrimStart / activeVideoDuration) * 100}%`,
                      width: `${Math.max(2, (activeTrimLen / activeVideoDuration) * 100)}%`,
                    }}
                  />
                  {canSplitActive && (
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-white shadow"
                      style={{
                        left: `${(splitPointSec / activeVideoDuration) * 100}%`,
                      }}
                    />
                  )}
                </div>

                {/* Trim Start & End sliders */}
                <div className="grid grid-cols-2 gap-3">
                  <label className="block space-y-1">
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-zinc-400 font-sans">Trim Start</span>
                      <span className="text-zinc-200 tabular-nums">{formatSec(activeTrimStart)}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, Number((activeTrimEnd - MIN_VIDEO_CLIP_SEC).toFixed(2)))}
                      step={0.05}
                      value={activeTrimStart}
                      onChange={(e) => {
                        const nextStart = Number(e.target.value);
                        onTrimClip(activeClip.id, nextStart, activeTrimEnd);
                        onScrubClipTime(activeClip.id, nextStart);
                      }}
                      className="w-full accent-amber-400 h-1.5 cursor-pointer"
                    />
                  </label>

                  <label className="block space-y-1">
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-zinc-400 font-sans">Trim End</span>
                      <span className="text-zinc-200 tabular-nums">{formatSec(activeTrimEnd)}</span>
                    </div>
                    <input
                      type="range"
                      min={Math.min(
                        activeVideoDuration,
                        Number((activeTrimStart + MIN_VIDEO_CLIP_SEC).toFixed(2))
                      )}
                      max={activeVideoDuration}
                      step={0.05}
                      value={activeTrimEnd}
                      onChange={(e) => {
                        const nextEnd = Number(e.target.value);
                        onTrimClip(activeClip.id, activeTrimStart, nextEnd);
                        onScrubClipTime(activeClip.id, nextEnd);
                      }}
                      className="w-full accent-amber-400 h-1.5 cursor-pointer"
                    />
                  </label>
                </div>

                {/* Cut / Split Playhead + Split Button */}
                <div className="flex items-center gap-2.5 pt-2 border-t border-white/10">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-zinc-400 font-sans">Cut Point</span>
                      <span className="text-white tabular-nums">
                        {canSplitActive ? formatSec(splitPointSec) : 'Too short'}
                      </span>
                    </div>
                    <input
                      type="range"
                      disabled={!canSplitActive}
                      min={Number((activeTrimStart + MIN_VIDEO_CLIP_SEC).toFixed(2))}
                      max={Number(
                        Math.max(
                          activeTrimStart + MIN_VIDEO_CLIP_SEC,
                          activeTrimEnd - MIN_VIDEO_CLIP_SEC
                        ).toFixed(2)
                      )}
                      step={0.05}
                      value={splitPointSec}
                      onChange={(e) => {
                        const pt = Number(e.target.value);
                        setSplitPointSec(pt);
                        onScrubClipTime(activeClip.id, pt);
                      }}
                      className="w-full accent-white h-1.5 cursor-pointer disabled:opacity-35"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={!canSplitActive}
                    onClick={handleSplitAction}
                    className="min-h-[38px] px-3.5 rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 disabled:opacity-35 text-xs font-bold flex items-center gap-1.5 shrink-0 transition"
                  >
                    <Scissors className="w-3.5 h-3.5" />
                    <span>Split</span>
                  </button>
                </div>

                {splitFeedback && (
                  <p className="text-[11px] text-emerald-300">{splitFeedback}</p>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center text-center gap-2.5 py-2">
                {videoClips.length > 0 ? (
                  <>
                    <p className="text-xs text-zinc-400">
                      Select a video clip to trim start/end or split &amp; cut sections:
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-1.5">
                      {videoClips.map(({ clip, idx }) => {
                        const len = Math.max(
                          MIN_VIDEO_CLIP_SEC,
                          (clip.trimEnd ?? clip.sourceDuration ?? 3) - (clip.trimStart ?? 0)
                        );
                        return (
                          <button
                            key={clip.id}
                            type="button"
                            onClick={() => setSelectedPhotoId(clip.id)}
                            className="min-h-[34px] px-3 rounded-xl bg-amber-400/15 border border-amber-400/35 text-amber-200 hover:bg-amber-400/25 text-xs font-semibold flex items-center gap-1.5 transition"
                          >
                            <Film className="w-3.5 h-3.5" />
                            <span>
                              Clip #{idx + 1} ({formatSec(len)})
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-zinc-400 max-w-xs">
                      Add a video clip to trim its start/end or split and cut out unwanted parts.
                    </p>
                    <button
                      type="button"
                      disabled={isLoadingMedia}
                      onClick={() => videoInputRef.current?.click()}
                      className="min-h-[40px] px-4 rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 disabled:opacity-40 text-xs font-bold flex items-center gap-1.5 transition"
                    >
                      {isLoadingMedia ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Video className="w-4 h-4" />
                      )}
                      <span>Add Video Clip</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* 3. INSHOT PRO TRANSITIONS DROPDOWN */}
        {activeTool === 'transition' && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="pro-transition-select" className="text-zinc-400 font-medium">
                Transition Style
              </label>
              <span className="font-mono text-zinc-200">{activeTransitionLabel}</span>
            </div>

            <div className="relative">
              <select
                id="pro-transition-select"
                value={transitionChoice}
                onChange={(e) => onTransitionChange(e.target.value as TransitionChoice)}
                className="w-full min-h-[48px] appearance-none rounded-xl bg-[#08080A] border border-white/15 pl-4 pr-11 text-sm font-medium text-white focus:outline-none focus:border-white/45 cursor-pointer transition"
              >
                {TRANSITION_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id} className="bg-[#111114] text-white">
                    {preset.id === 'auto'
                      ? `Template Auto (${TRANSITION_PRESETS.find((t) => t.id === template.transition)?.label || template.transition})`
                      : preset.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            </div>
          </div>
        )}

        {/* 4. TEXT OVERLAY TRAY */}
        {activeTool === 'text' && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-400">
                Leave empty for a clean video with zero text or date stamp
              </span>
              {(title.trim() || subtitle.trim()) && (
                <button
                  type="button"
                  onClick={() => {
                    onTitleChange('');
                    onSubtitleChange('');
                  }}
                  className="min-h-[28px] px-2.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-zinc-200 hover:bg-white/[0.12] flex items-center gap-1 shrink-0 transition"
                >
                  <X className="w-3 h-3" />
                  <span>Clear Text</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-zinc-400">Title (Optional)</span>
                <input
                  type="text"
                  maxLength={36}
                  value={title}
                  onChange={(e) => onTitleChange(e.target.value)}
                  placeholder="No title"
                  className="w-full min-h-[42px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-zinc-400">
                  Subtitle / Date (Optional)
                </span>
                <input
                  type="text"
                  maxLength={44}
                  value={subtitle}
                  onChange={(e) => onSubtitleChange(e.target.value)}
                  placeholder="No subtitle or date"
                  className="w-full min-h-[42px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                />
              </label>
            </div>
          </div>
        )}

        {/* 5. SPEED & LANDSCAPE TILT TRAY */}
        {activeTool === 'speed' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-zinc-400 font-mono tabular-nums">
                <span className="font-sans font-medium">Photo Pace</span>
                <span>
                  {slideSec}s / photo · ~{estTotal}s total
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {PACE_OPTIONS.map((opt) => {
                  const active = pace === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => onPaceChange(opt.id)}
                      className={`min-h-[46px] px-3 py-1.5 rounded-xl border text-center transition ${
                        active
                          ? 'bg-white text-[#08080A] border-white'
                          : 'bg-[#08080A] text-zinc-200 border-white/10 hover:border-white/25'
                      }`}
                    >
                      <div className="text-xs font-bold">{opt.label}</div>
                      <div
                        className={`text-[10px] mt-0.5 ${
                          active ? 'text-zinc-700' : 'text-zinc-500'
                        }`}
                      >
                        {opt.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/10">
              <span className="text-xs font-medium text-zinc-400 whitespace-nowrap">
                Landscape Tilt
              </span>
              <div className="grid grid-cols-2 gap-1.5 flex-1 max-w-[240px]">
                <button
                  type="button"
                  onClick={() => onLandscapeTiltChange('left')}
                  className={`min-h-[38px] px-3 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                    landscapeTilt === 'left'
                      ? 'bg-white text-[#08080A] border-white'
                      : 'bg-[#08080A] text-zinc-300 border-white/10 hover:border-white/25'
                  }`}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Left</span>
                </button>
                <button
                  type="button"
                  onClick={() => onLandscapeTiltChange('right')}
                  className={`min-h-[38px] px-3 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                    landscapeTilt === 'right'
                      ? 'bg-white text-[#08080A] border-white'
                      : 'bg-[#08080A] text-zinc-300 border-white/10 hover:border-white/25'
                  }`}
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  <span>Right</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
