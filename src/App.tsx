import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, Images, LayoutGrid } from 'lucide-react';
import { AdminConsole } from './components/AdminConsole';
import { DownloadVideoModal } from './components/DownloadVideoModal';
import { GalleryPhoto, PhotoTextEditor } from './components/PhotoTextEditor';
import { TemplateGallery } from './components/TemplateGallery';
import { VideoPreviewStage } from './components/VideoPreviewStage';
import {
  LandscapeTilt,
  PaceMode,
  REEL_TEMPLATES,
  ReelTemplate,
  TemplateCategory,
  TransitionChoice,
} from './data/templates';
import {
  DEFAULT_APP_CONFIG,
  fetchPublicAppConfig,
  PublicAppConfig,
  runRewardedAd,
  shouldTriggerRewardAd,
} from './lib/adNetworks';
import { haptic, initTelegramApp, TelegramContextInfo } from './lib/telegram';
import {
  exportReelMp4,
  ExportVideoResult,
  FrameImage,
  loadOrientedImage,
} from './lib/videoRenderer';

type StudioView = 'templates' | 'edit';

function makeSampleGallery(template: ReelTemplate): GalleryPhoto[] {
  return template.samplePhotos.map((url, idx) => ({
    id: `sample-${template.id}-${idx}`,
    previewUrl: url,
    name: `${template.name} ${idx + 1}`,
    isSample: true,
  }));
}

export default function App() {
  // Hidden /admin route (never linked anywhere in user-facing UI)
  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/admin'
  );

  const [appConfig, setAppConfig] = useState<PublicAppConfig>(DEFAULT_APP_CONFIG);
  const [tgContext, setTgContext] = useState<TelegramContextInfo>({
    isTelegram: false,
    initData: '',
    userId: '',
    username: '',
  });

  // Clean 2-view workflow: Templates & Photos Edit
  const [view, setView] = useState<StudioView>('templates');
  const [activeCategory, setActiveCategory] = useState<TemplateCategory>('travel');
  const [selectedTemplate, setSelectedTemplate] = useState<ReelTemplate>(REEL_TEMPLATES[0]);

  const [photos, setPhotos] = useState<GalleryPhoto[]>(() =>
    makeSampleGallery(REEL_TEMPLATES[0])
  );
  const [decodedFrames, setDecodedFrames] = useState<FrameImage[]>([]);
  const rawFileMapRef = useRef<Map<string, File>>(new Map());

  const [title, setTitle] = useState<string>(REEL_TEMPLATES[0].defaultTitle);
  const [subtitle, setSubtitle] = useState<string>(REEL_TEMPLATES[0].defaultSubtitle);
  const [pace, setPace] = useState<PaceMode>('normal');
  const [landscapeTilt, setLandscapeTilt] = useState<LandscapeTilt>('right');
  const [transitionChoice, setTransitionChoice] = useState<TransitionChoice>('auto');

  // Download Video Sheet state
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [isRunningAd, setIsRunningAd] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedVideo, setExportedVideo] = useState<ExportVideoResult | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [telegramSendStatus, setTelegramSendStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const refreshConfig = useCallback(async () => {
    const cfg = await fetchPublicAppConfig();
    setAppConfig(cfg);
  }, []);

  useEffect(() => {
    setTgContext(initTelegramApp());
    refreshConfig();

    const onPop = () => {
      setIsAdminRoute(window.location.pathname.replace(/\/+$/, '') === '/admin');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [refreshConfig]);

  // Decode EXIF-oriented ImageBitmaps whenever photo list updates
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      photos.map(async (item) => {
        const rawFile = rawFileMapRef.current.get(item.id);
        try {
          return await loadOrientedImage(rawFile ?? item.previewUrl);
        } catch {
          return null;
        }
      })
    ).then((loaded) => {
      if (cancelled) return;
      const valid = loaded.filter((f): f is FrameImage => f !== null);
      setDecodedFrames(valid);
    });
    return () => {
      cancelled = true;
    };
  }, [photos]);

  useEffect(() => {
    return () => {
      if (exportedVideo?.url) {
        URL.revokeObjectURL(exportedVideo.url);
      }
    };
  }, [exportedVideo]);

  const handleSelectTemplate = (tpl: ReelTemplate, openEditor = false) => {
    haptic('light');
    setSelectedTemplate(tpl);
    setTitle(tpl.defaultTitle);
    setSubtitle(tpl.defaultSubtitle);
    setTransitionChoice('auto');
    setPhotos((prev) => (prev.every((p) => p.isSample) ? makeSampleGallery(tpl) : prev));
    setExportedVideo(null);
    setTelegramSendStatus(null);
    if (openEditor) {
      setView('edit');
    }
  };

  const handleAddPhotos = (files: FileList) => {
    haptic('light');
    const validFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (validFiles.length === 0) return;

    const incoming: GalleryPhoto[] = validFiles.slice(0, 10).map((file, i) => {
      const id = `photo-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
      rawFileMapRef.current.set(id, file);
      return {
        id,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
        isSample: false,
      };
    });

    setPhotos((prev) => {
      const onlySamples = prev.every((p) => p.isSample);
      const base = onlySamples ? [] : prev;
      return [...base, ...incoming].slice(0, 10);
    });
    setExportedVideo(null);
    setTelegramSendStatus(null);
  };

  const handleRemovePhoto = (id: string) => {
    setPhotos((prev) => {
      if (prev.length <= 1) return prev;
      const target = prev.find((p) => p.id === id);
      if (target && !target.isSample) {
        URL.revokeObjectURL(target.previewUrl);
        rawFileMapRef.current.delete(id);
      }
      return prev.filter((p) => p.id !== id);
    });
    setExportedVideo(null);
  };

  const handleMovePhoto = (fromIdx: number, toIdx: number) => {
    setPhotos((prev) => {
      if (toIdx < 0 || toIdx >= prev.length || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
    setExportedVideo(null);
  };

  const handleResetSamples = () => {
    setPhotos((prev) => {
      prev.forEach((p) => {
        if (!p.isSample) {
          URL.revokeObjectURL(p.previewUrl);
          rawFileMapRef.current.delete(p.id);
        }
      });
      return makeSampleGallery(selectedTemplate);
    });
    setExportedVideo(null);
  };

  const handleDownloadVideoClick = async () => {
    setDownloadModalOpen(true);

    // If current edit is already rendered and ready, reopen the ready sheet immediately
    if (exportedVideo && !isExporting && !isRunningAd) {
      return;
    }

    if (decodedFrames.length === 0) {
      setExportError('Wait a moment for your photos to finish loading.');
      return;
    }

    setExportError(null);
    setTelegramSendStatus(null);
    haptic('medium');

    // Step A: Trigger configured Rewarded Ad (skips automatically if disabled/unconfigured)
    if (shouldTriggerRewardAd(appConfig)) {
      setIsRunningAd(true);
      const adResult = await runRewardedAd(appConfig);
      setIsRunningAd(false);
      if (adResult === 'cancelled') {
        setExportError('Watch the short sponsored video to unlock HD download.');
        return;
      }
    }

    // Step B: Client-side 720x1280 30fps H.264 MP4 encoding
    setIsExporting(true);
    setExportProgress(0);
    setExportedVideo(null);

    const abortController = new AbortController();
    exportAbortRef.current = abortController;

    try {
      const result = await exportReelMp4({
        config: {
          template: selectedTemplate,
          images: decodedFrames,
          title,
          subtitle,
          pace,
          landscapeTilt,
          transitionOverride: transitionChoice,
          watermarkEnabled: appConfig.watermark_enabled,
          watermarkText: appConfig.watermark_text,
        },
        onProgress: setExportProgress,
        signal: abortController.signal,
      });

      setExportedVideo(result);
      haptic('success');
    } catch (err) {
      if (err instanceof Error && err.message !== 'Export cancelled') {
        setExportError(err.message || 'Could not prepare MP4 on this device.');
      }
    } finally {
      setIsExporting(false);
      exportAbortRef.current = null;
    }
  };

  const handleSendToTelegramChat = async () => {
    if (!exportedVideo) return;
    setIsSendingTelegram(true);
    setTelegramSendStatus(null);
    try {
      const form = new FormData();
      form.append(
        'video',
        exportedVideo.blob,
        `ReelCraft-${selectedTemplate.id}.${exportedVideo.extension}`
      );
      form.append('initData', tgContext.initData);
      form.append(
        'caption',
        `${title.trim() || selectedTemplate.name} · Made with ${appConfig.site_name}`
      );

      const res = await fetch('/api/send-video', {
        method: 'POST',
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setTelegramSendStatus({
          ok: false,
          message:
            data.error ||
            'Open inside Telegram to send directly to chat, or tap Download Video below.',
        });
        return;
      }
      haptic('success');
      setTelegramSendStatus({
        ok: true,
        message: data.message || 'Sent to your Telegram chat! Open chat to share to WhatsApp Status.',
      });
    } catch {
      setTelegramSendStatus({
        ok: false,
        message: 'Could not reach Telegram delivery route. Tap Download Video below.',
      });
    } finally {
      setIsSendingTelegram(false);
    }
  };

  const nativeShareSupported = useMemo(
    () => typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    []
  );

  const handleNativeShare = async () => {
    if (!exportedVideo) return;
    try {
      const file = new File(
        [exportedVideo.blob],
        `ReelCraft-${selectedTemplate.id}.${exportedVideo.extension}`,
        { type: exportedVideo.mimeType }
      );
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: title.trim() || selectedTemplate.name,
        });
      } else {
        await navigator.share({
          title: title.trim() || selectedTemplate.name,
          url: window.location.origin,
        });
      }
    } catch {
      // User dismissed share sheet
    }
  };

  if (isAdminRoute) {
    return (
      <AdminConsole
        onExitToApp={() => {
          window.history.pushState({}, '', '/');
          setIsAdminRoute(false);
        }}
        onConfigUpdated={refreshConfig}
      />
    );
  }

  const adProviderNames: Record<PublicAppConfig['ad_provider'], string> = {
    adsgram: 'AdsGram',
    monetag: 'Monetag',
    richads: 'RichAds',
    gigapub: 'GigaPub',
  };

  return (
    <div
      className={`bg-[#08080A] text-zinc-100 flex flex-col ${
        view === 'edit' ? 'h-[100dvh] overflow-hidden' : 'min-h-screen'
      }`}
    >
      {/* Top Bar: Clean 3-zone header — Templates & Photos Edit + Download Video */}
      <header className="border-b border-white/10 bg-[#08080A]/95 backdrop-blur-md shrink-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-6">
          {/* Zone 1: Brand or mobile Back-to-Templates */}
          <div className="flex items-center gap-2 shrink-0">
            {view === 'edit' ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    haptic('light');
                    setView('templates');
                  }}
                  className="md:hidden min-h-[40px] px-2.5 -ml-2 flex items-center gap-1.5 text-sm font-medium text-zinc-300 hover:text-white rounded-xl transition whitespace-nowrap"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Templates</span>
                </button>
                <a
                  href="/"
                  onClick={(e) => {
                    e.preventDefault();
                    setView('templates');
                  }}
                  className="hidden md:block text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
                >
                  {appConfig.site_name}
                </a>
              </>
            ) : (
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  setView('templates');
                }}
                className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
              >
                {appConfig.site_name}
              </a>
            )}
          </div>

          {/* Zone 2: Clean 2-section Navigation (Templates | Edit Photos) */}
          <nav
            aria-label="Workspace sections"
            className="hidden md:flex items-center gap-8 text-sm font-medium text-zinc-400"
          >
            <button
              type="button"
              onClick={() => setView('templates')}
              className={`py-1 whitespace-nowrap shrink-0 transition-colors ${
                view === 'templates'
                  ? 'text-white underline decoration-white decoration-2 underline-offset-8'
                  : 'hover:text-white'
              }`}
            >
              Templates
            </button>
            <button
              type="button"
              onClick={() => setView('edit')}
              className={`py-1 whitespace-nowrap shrink-0 transition-colors ${
                view === 'edit'
                  ? 'text-white underline decoration-white decoration-2 underline-offset-8'
                  : 'hover:text-white'
              }`}
            >
              Photos Edit
            </button>
          </nav>

          {/* Zone 3: Single Primary Action — Download Video */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={handleDownloadVideoClick}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 active:scale-[0.98] flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Video</span>
            </button>
          </div>
        </div>
      </header>

      {/* VIEW 1: TEMPLATES GALLERY */}
      {view === 'templates' && (
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pt-5 pb-24 md:py-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-start">
            <div className="lg:col-span-7 xl:col-span-8">
              <TemplateGallery
                selectedTemplate={selectedTemplate}
                activeCategory={activeCategory}
                watermarkEnabled={appConfig.watermark_enabled}
                watermarkText={appConfig.watermark_text}
                onCategoryChange={(cat) => {
                  haptic('light');
                  setActiveCategory(cat);
                }}
                onSelectTemplate={handleSelectTemplate}
              />
            </div>

            <aside className="hidden lg:block lg:col-span-5 xl:col-span-4 lg:sticky lg:top-20">
              <div className="rounded-3xl bg-[#111114] border border-white/10 p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Selected Style</h2>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      {selectedTemplate.name} · {selectedTemplate.badge}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setView('edit')}
                    className="text-xs font-semibold text-white hover:underline whitespace-nowrap"
                  >
                    Edit Photos →
                  </button>
                </div>

                <VideoPreviewStage
                  template={selectedTemplate}
                  images={decodedFrames}
                  title={title}
                  subtitle={subtitle}
                  pace={pace}
                  landscapeTilt={landscapeTilt}
                  transitionOverride={transitionChoice}
                  watermarkEnabled={appConfig.watermark_enabled}
                  watermarkText={appConfig.watermark_text}
                  isExporting={isExporting}
                />
              </div>
            </aside>
          </div>
        </main>
      )}

      {/* VIEW 2: CAPCUT / INSHOT ZERO-SCROLL PHOTOS EDIT STUDIO */}
      {view === 'edit' && (
        <main className="flex-1 min-h-0 max-w-7xl w-full mx-auto flex flex-col lg:grid lg:grid-cols-12 lg:gap-8 lg:px-6 lg:py-6 overflow-hidden">
          {/* Always-visible Live Video Stage (Top half on mobile, Left column on desktop) */}
          <div className="flex-1 min-h-0 px-4 pt-3 pb-2 lg:p-0 lg:col-span-6 flex flex-col items-center justify-center overflow-hidden">
            <VideoPreviewStage
              template={selectedTemplate}
              images={decodedFrames}
              title={title}
              subtitle={subtitle}
              pace={pace}
              landscapeTilt={landscapeTilt}
              transitionOverride={transitionChoice}
              watermarkEnabled={appConfig.watermark_enabled}
              watermarkText={appConfig.watermark_text}
              isExporting={isExporting}
              fillViewport
            />
          </div>

          {/* Instant Thumb-Zone Edit Dock (Pinned directly below video on mobile, Right column on desktop) */}
          <div className="shrink-0 lg:col-span-6 lg:flex lg:flex-col lg:justify-center pb-safe lg:pb-0">
            <div className="hidden lg:flex items-center justify-between mb-4 px-1">
              <div>
                <h1 className="text-xl font-bold text-white">Photos Edit</h1>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {selectedTemplate.name} · Changes update live in the preview
                </p>
              </div>
              <button
                type="button"
                onClick={handleDownloadVideoClick}
                className="min-h-[44px] px-5 py-2 text-xs font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 flex items-center gap-2 transition whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                <span>Download Video</span>
              </button>
            </div>

            <PhotoTextEditor
              template={selectedTemplate}
              photos={photos}
              title={title}
              subtitle={subtitle}
              pace={pace}
              landscapeTilt={landscapeTilt}
              transitionChoice={transitionChoice}
              onAddPhotos={handleAddPhotos}
              onRemovePhoto={handleRemovePhoto}
              onMovePhoto={handleMovePhoto}
              onResetSamples={handleResetSamples}
              onTitleChange={(v) => {
                setTitle(v);
                setExportedVideo(null);
              }}
              onSubtitleChange={(v) => {
                setSubtitle(v);
                setExportedVideo(null);
              }}
              onPaceChange={(p) => {
                haptic('light');
                setPace(p);
                setExportedVideo(null);
              }}
              onLandscapeTiltChange={(tilt) => {
                haptic('light');
                setLandscapeTilt(tilt);
                setExportedVideo(null);
              }}
              onTransitionChange={(choice) => {
                haptic('light');
                setTransitionChoice(choice);
                setExportedVideo(null);
              }}
            />
          </div>
        </main>
      )}

      {/* Mobile Bottom Navigation (shown on Templates view; hidden on Edit view so the Edit Tool Dock owns the thumb zone) */}
      {view === 'templates' && (
        <nav
          aria-label="Mobile navigation"
          className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#08080A]/95 backdrop-blur-md border-t border-white/10 pb-safe"
        >
          <div className="grid grid-cols-2 h-14">
            <button
              type="button"
              onClick={() => {
                haptic('light');
                setView('templates');
              }}
              className="flex flex-col items-center justify-center gap-0.5 text-white transition-colors"
            >
              <LayoutGrid className="w-5 h-5" />
              <span className="text-[11px] font-semibold">Templates</span>
            </button>

            <button
              type="button"
              onClick={() => {
                haptic('light');
                setView('edit');
              }}
              className="flex flex-col items-center justify-center gap-0.5 text-zinc-400 hover:text-white transition-colors"
            >
              <Images className="w-5 h-5" />
              <span className="text-[11px] font-medium">Photos Edit</span>
            </button>
          </div>
        </nav>
      )}

      {/* Download Video Sheet (Ad Gate → HD MP4 Encode → Send to Telegram / Download) */}
      <DownloadVideoModal
        open={downloadModalOpen}
        templateName={selectedTemplate.name}
        adProviderLabel={adProviderNames[appConfig.ad_provider]}
        isRunningAd={isRunningAd}
        isExporting={isExporting}
        exportProgress={exportProgress}
        exportError={exportError}
        exportedVideo={exportedVideo}
        isSendingTelegram={isSendingTelegram}
        telegramSendStatus={telegramSendStatus}
        nativeShareSupported={nativeShareSupported}
        onRetry={() => {
          setExportedVideo(null);
          handleDownloadVideoClick();
        }}
        onCancelExport={() => exportAbortRef.current?.abort()}
        onClose={() => setDownloadModalOpen(false)}
        onSendToTelegramChat={handleSendToTelegramChat}
        onNativeShare={handleNativeShare}
      />
    </div>
  );
}
