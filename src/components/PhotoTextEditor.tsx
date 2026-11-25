import { ChangeEvent, DragEvent, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Gauge,
  ImagePlus,
  Images,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trash2,
  Type,
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
  previewUrl: string;
  name: string;
  isSample?: boolean;
}

type EditorTool = 'photos' | 'transition' | 'text' | 'speed';

interface PhotoTextEditorProps {
  template: ReelTemplate;
  photos: GalleryPhoto[];
  title: string;
  subtitle: string;
  pace: PaceMode;
  landscapeTilt: LandscapeTilt;
  transitionChoice: TransitionChoice;
  onAddPhotos: (files: FileList) => void;
  onRemovePhoto: (id: string) => void;
  onMovePhoto: (fromIdx: number, toIdx: number) => void;
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
  { id: 'photos', label: 'Photos', icon: Images },
  { id: 'transition', label: 'Transition', icon: Sparkles },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'speed', label: 'Speed', icon: Gauge },
];

export function PhotoTextEditor({
  template,
  photos,
  title,
  subtitle,
  pace,
  landscapeTilt,
  transitionChoice,
  onAddPhotos,
  onRemovePhoto,
  onMovePhoto,
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hasOnlySamples = photos.every((p) => p.isSample);
  const slideSec = getSlideDuration(template, pace);
  const estTotal = Number(
    (photos.length * slideSec + (template.overlay === 'kinetic-intro' ? 1.0 : 0)).toFixed(1)
  );

  const selectedIndex = photos.findIndex((p) => p.id === selectedPhotoId);
  const activeIdx = selectedIndex >= 0 ? selectedIndex : 0;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddPhotos(e.target.files);
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

  return (
    <div className="flex flex-col bg-[#101013] border-t lg:border border-white/10 lg:rounded-3xl overflow-hidden">
      {/* Hidden gallery input */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileChange}
        className="sr-only"
        aria-label="Pick up to 50 photos from gallery"
      />

      {/* CapCut / InShot Tool Selector Row — sits directly under live video so every change previews immediately */}
      <div
        role="tablist"
        aria-label="Edit tools"
        className="grid grid-cols-4 border-b border-white/10 bg-[#0C0C0F]"
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
              className={`min-h-[48px] flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-2 py-2 text-[11px] sm:text-xs font-semibold transition border-b-2 whitespace-nowrap ${
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

      {/* Compact Active Tool Tray — stays visible right below video with ZERO page scrolling */}
      <div className="p-3.5 sm:p-5 min-h-[156px] lg:min-h-[260px] flex flex-col justify-center">
        {/* 1. PHOTOS FILMSTRIP TRAY */}
        {activeTool === 'photos' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-zinc-400 font-mono tabular-nums">
                {hasOnlySamples
                  ? 'Sample photos · Tap + to pick up to 50 yours'
                  : `${photos.length}/50 photos · Tap clip to reorder`}
              </span>
              <div className="flex items-center gap-1.5">
                {!hasOnlySamples && (
                  <button
                    type="button"
                    onClick={onResetSamples}
                    className="min-h-[34px] px-2.5 text-[11px] font-medium rounded-lg bg-white/[0.05] border border-white/10 text-zinc-300 hover:text-white flex items-center gap-1 transition whitespace-nowrap"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset</span>
                  </button>
                )}
                {photos.length > 1 && (
                  <div className="flex items-center gap-1 bg-white/[0.04] border border-white/10 rounded-lg p-0.5">
                    <button
                      type="button"
                      onClick={() => onMovePhoto(activeIdx, activeIdx - 1)}
                      disabled={activeIdx <= 0}
                      aria-label="Move selected photo earlier"
                      className="min-h-[30px] min-w-[30px] flex items-center justify-center rounded-md text-zinc-300 hover:bg-white/10 disabled:opacity-25 transition"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMovePhoto(activeIdx, activeIdx + 1)}
                      disabled={activeIdx >= photos.length - 1}
                      aria-label="Move selected photo later"
                      className="min-h-[30px] min-w-[30px] flex items-center justify-center rounded-md text-zinc-300 hover:bg-white/10 disabled:opacity-25 transition"
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemovePhoto(photos[activeIdx].id)}
                      aria-label="Remove selected photo"
                      className="min-h-[30px] min-w-[30px] flex items-center justify-center rounded-md text-zinc-300 hover:text-red-400 hover:bg-red-500/15 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Horizontal scrollable filmstrip like CapCut / InShot */}
            <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar pb-1">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={!hasOnlySamples && photos.length >= 50}
                className="shrink-0 w-[72px] h-[96px] rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 disabled:opacity-40 flex flex-col items-center justify-center gap-1 transition"
              >
                <ImagePlus className="w-5 h-5" />
                <span className="text-[11px] font-bold">
                  {hasOnlySamples ? 'Add' : `${photos.length}/50`}
                </span>
              </button>

              {photos.map((photo, idx) => {
                const isSelected = idx === activeIdx;
                return (
                  <div
                    key={photo.id}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={handleDragOver}
                    onDrop={() => handleDrop(idx)}
                    onDragEnd={() => setDragIdx(null)}
                    onClick={() => setSelectedPhotoId(photo.id)}
                    className={`relative shrink-0 w-[72px] h-[96px] rounded-xl overflow-hidden cursor-pointer border-2 transition ${
                      dragIdx === idx
                        ? 'opacity-50 border-white/60'
                        : isSelected
                        ? 'border-white ring-2 ring-white/25'
                        : 'border-white/10 hover:border-white/30'
                    }`}
                  >
                    <img
                      src={photo.previewUrl}
                      alt={`Photo ${idx + 1}`}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/75 text-[10px] font-mono text-white tabular-nums">
                      {idx + 1}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2. INSHOT PRO TRANSITIONS DROPDOWN */}
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

        {/* 3. TEXT OVERLAY TRAY */}
        {activeTool === 'text' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-zinc-400">Title (Optional)</span>
              <input
                type="text"
                maxLength={36}
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                placeholder={template.defaultTitle}
                className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-zinc-400">Subtitle / Date (Optional)</span>
              <input
                type="text"
                maxLength={44}
                value={subtitle}
                onChange={(e) => onSubtitleChange(e.target.value)}
                placeholder={template.defaultSubtitle}
                className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
              />
            </label>
          </div>
        )}

        {/* 4. SPEED & LANDSCAPE TILT TRAY */}
        {activeTool === 'speed' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-zinc-400 font-mono tabular-nums">
                <span className="font-sans font-medium">Clip Speed</span>
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
