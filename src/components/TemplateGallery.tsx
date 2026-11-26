import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, SquarePlus } from 'lucide-react';
import {
  BLANK_TEMPLATE,
  CATEGORIES,
  PaceMode,
  REEL_TEMPLATES,
  ReelTemplate,
  TemplateCategory,
} from '../data/templates';
import {
  FrameImage,
  getTotalDuration,
  loadOrientedImage,
  renderFrame,
} from '../lib/videoRenderer';

interface TemplateGalleryProps {
  selectedTemplate: ReelTemplate;
  activeCategory: TemplateCategory;
  watermarkEnabled: boolean;
  watermarkText: string;
  onCategoryChange: (cat: TemplateCategory) => void;
  onSelectTemplate: (template: ReelTemplate, goNext?: boolean) => void;
}

const sampleImageCache = new Map<string, Promise<FrameImage>>();

function getCachedSampleImage(url: string): Promise<FrameImage> {
  const existing = sampleImageCache.get(url);
  if (existing) return existing;
  const promise = loadOrientedImage(url);
  sampleImageCache.set(url, promise);
  return promise;
}

interface MiniPreviewCardProps {
  template: ReelTemplate;
  isSelected: boolean;
  watermarkEnabled: boolean;
  watermarkText: string;
  onSelect: () => void;
  onUse: () => void;
}

function MiniPreviewCard({
  template,
  isSelected,
  watermarkEnabled,
  watermarkText,
  onSelect,
  onUse,
}: MiniPreviewCardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [images, setImages] = useState<FrameImage[]>([]);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      template.samplePhotos.map((u) => getCachedSampleImage(u).catch(() => null))
    ).then((res) => {
      if (cancelled) return;
      setImages(res.filter((img): img is FrameImage => img !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [template.samplePhotos]);

  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        setIsVisible(Boolean(entries[0]?.isIntersecting));
      },
      { rootMargin: '120px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || images.length === 0 || !isVisible) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const config = {
      template,
      images,
      title: template.defaultTitle,
      subtitle: template.defaultSubtitle,
      pace: 'fast' as PaceMode,
      watermarkEnabled,
      watermarkText,
    };
    const dur = getTotalDuration(config);

    let raf = 0;
    let lastDraw = 0;
    const startMs = performance.now();

    const tick = (now: number) => {
      // Smooth 18fps mini-preview keeps mobile scrolling silky at 60fps
      if (now - lastDraw >= 55) {
        lastDraw = now;
        const elapsed = ((now - startMs) / 1000) % dur;
        renderFrame(ctx, elapsed, config);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [images, isVisible, template, watermarkEnabled, watermarkText]);

  return (
    <div
      ref={cardRef}
      className={`group flex flex-col overflow-hidden rounded-2xl bg-[#111114] border transition-colors ${
        isSelected
          ? 'border-white/70 ring-1 ring-white/30'
          : 'border-white/10 hover:border-white/25'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="relative aspect-[9/16] w-full overflow-hidden bg-[#0B0B0E] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <canvas
          ref={canvasRef}
          width={270}
          height={480}
          className="h-full w-full block object-cover"
          aria-label={`Animated preview of ${template.name} template`}
        />

        {images.length === 0 && (
          <img
            src={template.samplePhotos[0]}
            alt={template.name}
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full object-cover opacity-70"
          />
        )}

        {isSelected && (
          <span className="absolute top-2.5 right-2.5 h-7 w-7 rounded-full bg-white text-[#08080A] flex items-center justify-center shadow-lg">
            <Check className="w-4 h-4 stroke-[2.5]" />
          </span>
        )}
      </button>

      <div className="p-3.5 flex flex-col justify-between gap-3 flex-1">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-white truncate">{template.name}</h3>
            <span className="text-[11px] font-mono text-zinc-400 shrink-0">{template.badge}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-400 line-clamp-2 leading-relaxed">
            {template.tagline}
          </p>
        </div>

        <button
          type="button"
          onClick={onUse}
          className={`min-h-[42px] w-full px-3 py-2 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition whitespace-nowrap ${
            isSelected
              ? 'bg-white text-[#08080A] hover:bg-zinc-200'
              : 'bg-white/[0.06] text-zinc-100 border border-white/10 hover:bg-white/[0.12]'
          }`}
        >
          <span>{isSelected ? 'Open Editor' : 'Use Style'}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export function TemplateGallery({
  selectedTemplate,
  activeCategory,
  watermarkEnabled,
  watermarkText,
  onCategoryChange,
  onSelectTemplate,
}: TemplateGalleryProps) {
  const templatesInCategory = useMemo(
    () => REEL_TEMPLATES.filter((t) => t.category === activeCategory),
    [activeCategory]
  );

  const isBlankSelected = selectedTemplate.id === BLANK_TEMPLATE.id;

  return (
    <section aria-label="Template catalog" className="space-y-5">
      <div className="space-y-1.5">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white [text-wrap:balance]">
          Cinematic templates for Status &amp; Reels
        </h1>
        <p className="text-sm text-zinc-400">
          Start blank with photos &amp; videos, or pick one of 25 silent 9:16 styles.
        </p>
      </div>

      {/* Start Blank Quick Card — always 1 tap away */}
      <div
        className={`rounded-2xl p-3.5 sm:p-4 border transition flex items-center justify-between gap-3 ${
          isBlankSelected
            ? 'bg-white/[0.06] border-white/60 ring-1 ring-white/25'
            : 'bg-[#111114] border-white/10 hover:border-white/25'
        }`}
      >
        <button
          type="button"
          onClick={() => onSelectTemplate(BLANK_TEMPLATE, false)}
          className="flex items-center gap-3 text-left min-w-0 flex-1"
        >
          <div className="h-11 w-11 rounded-xl bg-white/[0.08] border border-white/15 flex items-center justify-center shrink-0 text-white">
            {isBlankSelected ? <Check className="w-5 h-5" /> : <SquarePlus className="w-5 h-5" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white truncate">Blank Canvas</h2>
              <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-zinc-200 shrink-0">
                No Text · Clean
              </span>
            </div>
            <p className="text-xs text-zinc-400 truncate mt-0.5">
              Pure 9:16 editor for photos &amp; trimmed videos — zero filters or date stamps
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onSelectTemplate(BLANK_TEMPLATE, true)}
          className="min-h-[40px] px-3.5 py-2 rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 text-xs font-semibold flex items-center gap-1.5 shrink-0 transition whitespace-nowrap"
        >
          <span>Start Blank</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Category segmented filter tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1">
        {CATEGORIES.map((cat) => {
          const active = cat.id === activeCategory;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => onCategoryChange(cat.id)}
              className={`min-h-[42px] px-4 py-2 text-xs sm:text-sm font-medium rounded-xl whitespace-nowrap shrink-0 transition ${
                active
                  ? 'bg-white text-[#08080A] font-semibold'
                  : 'bg-white/[0.04] text-zinc-400 border border-white/10 hover:text-white hover:border-white/20'
              }`}
            >
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* 5 animated templates per category */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5 sm:gap-4">
        {templatesInCategory.map((tpl) => (
          <MiniPreviewCard
            key={tpl.id}
            template={tpl}
            isSelected={tpl.id === selectedTemplate.id}
            watermarkEnabled={watermarkEnabled}
            watermarkText={watermarkText}
            onSelect={() => onSelectTemplate(tpl, false)}
            onUse={() => onSelectTemplate(tpl, true)}
          />
        ))}
      </div>
    </section>
  );
}
