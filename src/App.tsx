import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, Images, LayoutGrid } from 'lucide-react';
import { AdminConsole } from './components/AdminConsole';
import { DownloadVideoModal } from './components/DownloadVideoModal';
import { GalleryPhoto, PhotoTextEditor } from './components/PhotoTextEditor';
import { ShortsFeedView } from './components/ShortsFeedView';
import { TemplateGallery } from './components/TemplateGallery';
import { VideoPreviewStage } from './components/VideoPreviewStage';
import {
  BLANK_TEMPLATE,
  LandscapeTilt,
  PaceMode,
  ReelTemplate,
  SAMPLE_MEDIA,
  TemplateCategory,
  TransitionChoice,
} from './data/templates';
import {
  DEFAULT_APP_CONFIG,
  fetchPublicAppConfig,
  getActiveRewardAdLabel,
  preloadCleanAdsSdk,
  PublicAppConfig,
  runInterstitialAd,
  runRewardedAd,
  shouldTriggerRewardAd,
} from './lib/adNetworks';
import {
  getInitialShortsRouteState,
  haptic,
  initTelegramApp,
  TelegramContextInfo,
  triggerTelegramNativeDownload,
} from './lib/telegram';
import {
  createClipVideoElement,
  exportReelMp4,
  ExportVideoResult,
  FrameImage,
  FrameSource,
  getSlideDuration,
  isVideoElement,
  loadOrientedImage,
  loadVideoAsset,
  RenderClip,
} from './lib/videoRenderer';

type StudioView = 'templates' | 'edit';

interface DecodedEntry {
  source: FrameSource;
  poster?: FrameImage;
}

function makeSampleGallery(template: ReelTemplate): GalleryPhoto[] {
  return template.samplePhotos.map((url, idx) => ({
    id: `sample-${template.id}-${idx}`,
    kind: 'photo',
    previewUrl: url,
    name: `${template.name} ${idx + 1}`,
    isSample: true,
  }));
}

export default function App() {
  // Hidden /admin and /shorts (or Telegram ?startapp=shorts) routes — never linked in main UI
  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/admin'
  );
  const [shortsRoute, setShortsRoute] = useState<{ isShorts: boolean; initialVideoId: string }>(
    () => getInitialShortsRouteState()
  );

  const [appConfig, setAppConfig] = useState<PublicAppConfig>(DEFAULT_APP_CONFIG);
  const [tgContext, setTgContext] = useState<TelegramContextInfo>({
    isTelegram: false,
    initData: '',
    userId: '',
    username: '',
    startParam: '',
  });

  // Clean 2-view workflow: Templates & Media Editor (starts Blank by default)
  const [view, setView] = useState<StudioView>('templates');
  const [activeCategory, setActiveCategory] = useState<TemplateCategory>('all');
  const [selectedTemplate, setSelectedTemplate] = useState<ReelTemplate>(BLANK_TEMPLATE);

  const [photos, setPhotos] = useState<GalleryPhoto[]>(() =>
    makeSampleGallery(BLANK_TEMPLATE)
  );
  const [decodedClips, setDecodedClips] = useState<RenderClip[]>([]);
  const decodedCacheRef = useRef<Map<string, DecodedEntry>>(new Map());
  const rawFileMapRef = useRef<Map<string, File>>(new Map());
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [scrubRequest, setScrubRequest] = useState<{ timeSec: number; nonce: number } | null>(null);
  const scrubNonceRef = useRef(0);

  const [title, setTitle] = useState<string>(BLANK_TEMPLATE.defaultTitle);
  const [subtitle, setSubtitle] = useState<string>(BLANK_TEMPLATE.defaultSubtitle);
  const [pace, setPace] = useState<PaceMode>('normal');
  const [landscapeTilt, setLandscapeTilt] = useState<LandscapeTilt>('right');
  const [transitionChoice, setTransitionChoice] = useState<TransitionChoice>('auto');
  const [chromaSensitivity, setChromaSensitivity] = useState<number>(0.55);
  const [customTemplates, setCustomTemplates] = useState<ReelTemplate[]>([]);
  const [presetOverlayClip, setPresetOverlayClip] = useState<RenderClip | null>(null);
  const presetVideoCacheRef = useRef<Map<string, RenderClip>>(new Map());

  // Download Video Sheet state
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [awaitingAdConfirm, setAwaitingAdConfirm] = useState(false);
  const [isRunningAd, setIsRunningAd] = useState(false);
  const [isRunningInterstitial, setIsRunningInterstitial] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const hasCompletedExportRef = useRef(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedVideo, setExportedVideo] = useState<ExportVideoResult | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);
  const [telegramSendStatus, setTelegramSendStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const preparedDownloadRef = useRef<{
    url: string;
    fileName: string;
    expiresAt: number;
  } | null>(null);
  const downloadCopyCountRef = useRef(0);

  const refreshConfig = useCallback(async () => {
    const [cfg, overlaysRes] = await Promise.all([
      fetchPublicAppConfig(),
      fetch('/api/overlays', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { overlays: [] }))
        .catch(() => ({ overlays: [] })),
    ]);
    setAppConfig(cfg);

    const list = Array.isArray((overlaysRes as { overlays?: unknown[] }).overlays)
      ? ((overlaysRes as {
          overlays: {
            id: string;
            name: string;
            tagline?: string;
            badge?: string;
            fit_mode?: string;
            chroma_sensitivity?: number;
            accent_color?: string;
            default_title?: string;
            stream_url: string;
          }[];
        }).overlays)
      : [];

    setCustomTemplates(
      list.map((ov) => ({
        id: `ov-${ov.id}`,
        name: ov.name,
        category: 'fx',
        tagline:
          ov.tagline ||
          'Premade green-screen AI video — just upload your photo or video as background',
        badge: ov.badge || 'AI Overlay',
        defaultTitle: ov.default_title || '',
        defaultSubtitle: '',
        paceMultiplier: 0.85,
        motionStyle: 'none',
        specialMode: 'chroma-green-screen',
        presetOverlayUrl: ov.stream_url,
        chromaFitMode: ov.fit_mode === 'detected-rect' ? 'detected-rect' : 'full-frame',
        defaultChromaSensitivity:
          typeof ov.chroma_sensitivity === 'number' ? ov.chroma_sensitivity : 0.55,
        isCustomOverlay: true,
        transition: 'dissolve',
        layout: 'full',
        grade: 'none',
        overlay: 'none',
        accentColor: ov.accent_color || '#F472B6',
        samplePhotos: [SAMPLE_MEDIA.birthdaySparkler, SAMPLE_MEDIA.travelCoast, SAMPLE_MEDIA.vibesCafe],
      }))
    );
  }, []);

  useEffect(() => {
    const tgInfo = initTelegramApp();
    setTgContext(tgInfo);
    if (tgInfo.startParam === 'shorts') {
      setShortsRoute({ isShorts: true, initialVideoId: '' });
    } else if (tgInfo.startParam.startsWith('short_') && tgInfo.startParam.length > 6) {
      setShortsRoute({ isShorts: true, initialVideoId: tgInfo.startParam.slice(6).trim() });
    }
    refreshConfig();

    const onPop = () => {
      setIsAdminRoute(window.location.pathname.replace(/\/+$/, '') === '/admin');
      setShortsRoute(getInitialShortsRouteState());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [refreshConfig]);

  // Preload CleanAds SDK once on startup when either CleanAds unit is enabled
  useEffect(() => {
    preloadCleanAdsSdk(appConfig);
  }, [appConfig]);

  const muteAndPauseDomMedia = useCallback(() => {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('video, audio').forEach((el) => {
      const media = el as HTMLMediaElement;
      try {
        media.muted = true;
        media.pause();
      } catch {
        // Ignore media pause errors
      }
    });
  }, []);

  const triggerInterstitialWithCooldown = useCallback(async () => {
    if (isRunningAd || isRunningInterstitial || isExporting) return;
    muteAndPauseDomMedia();
    setIsRunningInterstitial(true);
    try {
      await runInterstitialAd(appConfig);
    } finally {
      setIsRunningInterstitial(false);
    }
  }, [appConfig, isExporting, isRunningAd, isRunningInterstitial, muteAndPauseDomMedia]);

  // Decode & cache per-clip media (ImageBitmaps for photos, dedicated HTMLVideoElements for video clips)
  useEffect(() => {
    let cancelled = false;
    const activeIds = new Set(photos.map((p) => p.id));

    // Dispose removed clip decoders to keep mobile RAM & video decoder count low
    for (const [id, entry] of decodedCacheRef.current.entries()) {
      if (!activeIds.has(id)) {
        if (isVideoElement(entry.source)) {
          try {
            entry.source.pause();
            entry.source.removeAttribute('src');
            entry.source.load();
          } catch {
            // ignore
          }
        }
        decodedCacheRef.current.delete(id);
      }
    }

    Promise.all(
      photos.map(async (item): Promise<RenderClip | null> => {
        const cached = decodedCacheRef.current.get(item.id);
        if (cached) {
          return {
            id: item.id,
            kind: item.kind,
            source: cached.source,
            poster: cached.poster,
            trimStart: item.trimStart ?? 0,
            trimEnd: item.trimEnd ?? item.sourceDuration ?? 0,
          };
        }

        try {
          if (item.kind === 'video' && item.videoUrl) {
            const [videoEl, posterImg] = await Promise.all([
              createClipVideoElement(item.videoUrl, item.trimStart ?? 0),
              loadOrientedImage(item.previewUrl).catch(() => undefined),
            ]);
            if (cancelled) {
              videoEl.pause();
              videoEl.removeAttribute('src');
              videoEl.load();
              return null;
            }
            const entry: DecodedEntry = { source: videoEl, poster: posterImg };
            decodedCacheRef.current.set(item.id, entry);
            return {
              id: item.id,
              kind: 'video',
              source: videoEl,
              poster: posterImg,
              trimStart: item.trimStart ?? 0,
              trimEnd: item.trimEnd ?? item.sourceDuration ?? 3,
            };
          }

          const rawFile = rawFileMapRef.current.get(item.id);
          const img = await loadOrientedImage(rawFile ?? item.previewUrl);
          if (cancelled) return null;
          decodedCacheRef.current.set(item.id, { source: img });
          return {
            id: item.id,
            kind: 'photo',
            source: img,
            trimStart: 0,
            trimEnd: 0,
          };
        } catch {
          return null;
        }
      })
    ).then((loaded) => {
      if (cancelled) return;
      const valid = loaded.filter((c): c is RenderClip => c !== null);
      setDecodedClips(valid);
    });

    return () => {
      cancelled = true;
    };
  }, [photos]);

  // Keep photo-only array for backwards-compatible RenderConfig.images field
  const decodedFrames = useMemo<FrameImage[]>(
    () =>
      decodedClips
        .map((c) => (isVideoElement(c.source) ? c.poster : c.source))
        .filter((f): f is FrameImage => Boolean(f)),
    [decodedClips]
  );

  useEffect(() => {
    preparedDownloadRef.current = null;
    downloadCopyCountRef.current = 0;
    return () => {
      if (exportedVideo?.url) {
        URL.revokeObjectURL(exportedVideo.url);
      }
    };
  }, [exportedVideo]);

  const hasOpenedEditorRef = useRef(false);

  // Automatically decode & cache the locked foreground green-screen video for Premade AI Overlay templates
  useEffect(() => {
    const url = selectedTemplate.presetOverlayUrl;
    if (!url) {
      setPresetOverlayClip(null);
      return;
    }

    const cached = presetVideoCacheRef.current.get(url);
    if (cached) {
      setPresetOverlayClip(cached);
      return;
    }

    let cancelled = false;
    setIsLoadingMedia(true);
    createClipVideoElement(url, 0)
      .then((videoEl) => {
        if (cancelled) {
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.load();
          return;
        }
        const dur =
          Number.isFinite(videoEl.duration) && videoEl.duration > 0.3
            ? Number(videoEl.duration.toFixed(2))
            : 6.0;
        const clip: RenderClip = {
          id: `preset-${selectedTemplate.id}`,
          kind: 'video',
          source: videoEl,
          trimStart: 0,
          trimEnd: dur,
        };
        presetVideoCacheRef.current.set(url, clip);
        setPresetOverlayClip(clip);
      })
      .catch(() => {
        if (!cancelled) {
          setPresetOverlayClip(null);
          setMediaError('Could not load the premade overlay video. Check its URL or Telegram Bot setting.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingMedia(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTemplate.id, selectedTemplate.presetOverlayUrl]);

  const handleSelectTemplate = (tpl: ReelTemplate, openEditor = false) => {
    haptic('light');
    const isSwitchingProject =
      openEditor && (hasCompletedExportRef.current || (hasOpenedEditorRef.current && tpl.id !== selectedTemplate.id));
    setSelectedTemplate(tpl);
    setTitle(tpl.defaultTitle);
    setSubtitle(tpl.defaultSubtitle);
    setTransitionChoice('auto');
    if (typeof tpl.defaultChromaSensitivity === 'number') {
      setChromaSensitivity(tpl.defaultChromaSensitivity);
    } else if (tpl.specialMode === 'chroma-green-screen') {
      setChromaSensitivity(0.55);
    }
    setPhotos((prev) => (prev.every((p) => p.isSample) ? makeSampleGallery(tpl) : prev));
    setExportedVideo(null);
    setTelegramSendStatus(null);
    if (openEditor) {
      hasOpenedEditorRef.current = true;
      setView('edit');
      if (isSwitchingProject) {
        void triggerInterstitialWithCooldown();
      }
    }
  };

  const handleAddPhotos = (files: FileList) => {
    haptic('light');
    setMediaError(null);
    const validFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (validFiles.length === 0) return;

    const incoming: GalleryPhoto[] = validFiles.slice(0, 50).map((file, i) => {
      const id = `photo-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
      rawFileMapRef.current.set(id, file);
      return {
        id,
        kind: 'photo',
        previewUrl: URL.createObjectURL(file),
        name: file.name,
        isSample: false,
      };
    });

    setPhotos((prev) => {
      const onlySamples = prev.every((p) => p.isSample);
      if (onlySamples) {
        return incoming.slice(0, 50);
      }
      // In Green Screen mode (without a locked preset overlay), keep the user's green-screen foreground video while replacing sample placeholders
      if (selectedTemplate.specialMode === 'chroma-green-screen' && !selectedTemplate.presetOverlayUrl) {
        const cleaned = prev.filter((p) => !p.isSample);
        return [...cleaned, ...incoming].slice(0, 50);
      }
      return [...prev, ...incoming].slice(0, 50);
    });
    setExportedVideo(null);
    setTelegramSendStatus(null);
  };

  const handleSetGreenScreenVideo = async (files: FileList) => {
    haptic('light');
    setMediaError(null);
    const validFile = Array.from(files).find(
      (f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv|3gp)$/i.test(f.name)
    );
    if (!validFile) return;

    setIsLoadingMedia(true);
    try {
      const asset = await loadVideoAsset(validFile);
      const id = `green-fg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const fgItem: GalleryPhoto = {
        id,
        kind: 'video',
        previewUrl: asset.posterUrl,
        videoUrl: asset.videoUrl,
        name: validFile.name,
        isSample: false,
        sourceDuration: asset.duration,
        trimStart: 0,
        trimEnd: asset.duration,
      };

      setPhotos((prev) => {
        const existingFgIdx = prev.findIndex((p) => p.kind === 'video');
        if (existingFgIdx >= 0) {
          const oldFg = prev[existingFgIdx];
          const rest = prev.filter((_, idx) => idx !== existingFgIdx);
          if (oldFg.videoUrl && !rest.some((item) => item.videoUrl === oldFg.videoUrl)) {
            URL.revokeObjectURL(oldFg.videoUrl);
          }
          return [fgItem, ...rest].slice(0, 50);
        }
        // Keep sample photos right behind the uploaded green-screen video so user immediately sees live photos inside their green screen!
        return [fgItem, ...prev].slice(0, 50);
      });
      setExportedVideo(null);
      setTelegramSendStatus(null);
    } catch {
      setMediaError(`Could not open "${validFile.name}". Try an MP4 or MOV video.`);
    } finally {
      setIsLoadingMedia(false);
    }
  };

  const handleAddVideos = async (files: FileList) => {
    haptic('light');
    setMediaError(null);
    const validFiles = Array.from(files).filter(
      (f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv|3gp)$/i.test(f.name)
    );
    if (validFiles.length === 0) return;

    setIsLoadingMedia(true);
    try {
      const incoming: GalleryPhoto[] = [];
      for (let i = 0; i < Math.min(validFiles.length, 10); i += 1) {
        const file = validFiles[i];
        try {
          const asset = await loadVideoAsset(file);
          const id = `video-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
          incoming.push({
            id,
            kind: 'video',
            previewUrl: asset.posterUrl,
            videoUrl: asset.videoUrl,
            name: file.name,
            isSample: false,
            sourceDuration: asset.duration,
            trimStart: 0,
            trimEnd: asset.duration,
          });
        } catch {
          setMediaError(`Could not open "${file.name}". Try an MP4 or MOV video.`);
        }
      }

      if (incoming.length > 0) {
        setPhotos((prev) => {
          const onlySamples = prev.every((p) => p.isSample);
          if (selectedTemplate.specialMode === 'chroma-green-screen' && !selectedTemplate.presetOverlayUrl) {
            if (onlySamples) {
              // First video added on Green Screen mode becomes foreground; keep sample photos behind it for instant live preview!
              return [...incoming, ...prev].slice(0, 50);
            }
            const cleaned = prev.filter((p) => !p.isSample);
            return [...cleaned, ...incoming].slice(0, 50);
          }
          const base = onlySamples ? [] : prev;
          return [...base, ...incoming].slice(0, 50);
        });
        setExportedVideo(null);
        setTelegramSendStatus(null);
      }
    } finally {
      setIsLoadingMedia(false);
    }
  };

  const handleRemovePhoto = (id: string) => {
    setPhotos((prev) => {
      if (prev.length <= 1) return prev;
      const target = prev.find((p) => p.id === id);
      const remaining = prev.filter((p) => p.id !== id);
      if (target && !target.isSample) {
        if (target.kind === 'photo') {
          URL.revokeObjectURL(target.previewUrl);
          rawFileMapRef.current.delete(id);
        } else if (
          target.videoUrl &&
          !remaining.some((item) => item.videoUrl === target.videoUrl)
        ) {
          URL.revokeObjectURL(target.videoUrl);
        }
      }
      return remaining;
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

  const handleTrimClip = (id: string, trimStart: number, trimEnd: number) => {
    setPhotos((prev) =>
      prev.map((item) => {
        if (item.id !== id || item.kind !== 'video') return item;
        const maxDur = Math.max(0.4, item.sourceDuration ?? trimEnd);
        const safeStart = Math.max(0, Math.min(trimStart, maxDur - 0.3));
        const safeEnd = Math.max(safeStart + 0.3, Math.min(trimEnd, maxDur));
        return {
          ...item,
          trimStart: Number(safeStart.toFixed(2)),
          trimEnd: Number(safeEnd.toFixed(2)),
        };
      })
    );
    setExportedVideo(null);
  };

  const handleSplitClip = (id: string, splitAtSourceSec: number): string | null => {
    const idx = photos.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const target = photos[idx];
    if (target.kind !== 'video' || !target.videoUrl) return null;
    if (photos.length >= 50) {
      setMediaError('Maximum 50 clips reached. Delete a clip before splitting.');
      return null;
    }

    const start = target.trimStart ?? 0;
    const end = target.trimEnd ?? target.sourceDuration ?? 3;
    if (splitAtSourceSec <= start + 0.25 || splitAtSourceSec >= end - 0.25) {
      return null;
    }

    const newId = `video-cut-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const leftClip: GalleryPhoto = {
      ...target,
      trimStart: start,
      trimEnd: Number(splitAtSourceSec.toFixed(2)),
    };
    const rightClip: GalleryPhoto = {
      ...target,
      id: newId,
      name: `${target.name} (Cut)`,
      trimStart: Number(splitAtSourceSec.toFixed(2)),
      trimEnd: end,
    };

    haptic('medium');
    setPhotos((prev) => {
      const next = [...prev];
      const currentIdx = next.findIndex((p) => p.id === id);
      if (currentIdx < 0) return prev;
      next.splice(currentIdx, 1, leftClip, rightClip);
      return next;
    });
    setExportedVideo(null);
    return newId;
  };

  const handleScrubClipTime = (clipId: string, sourceTimeSec: number) => {
    const slideDur = getSlideDuration(selectedTemplate, pace);
    const specialMode = selectedTemplate.specialMode ?? 'none';

    if (specialMode === 'chroma-green-screen') {
      const fgVideo = photos.find((p) => p.kind === 'video');
      if (fgVideo && fgVideo.id === clipId) {
        const start = fgVideo.trimStart ?? 0;
        const end = fgVideo.trimEnd ?? fgVideo.sourceDuration ?? 3;
        const clampedOffset = Math.max(0, Math.min(sourceTimeSec - start, Math.max(0.05, end - start - 0.02)));
        scrubNonceRef.current += 1;
        setScrubRequest({ timeSec: clampedOffset, nonce: scrubNonceRef.current });
        return;
      }
    }

    const introDur =
      specialMode === 'india-train-map'
        ? 3.55
        : specialMode === 'map-route-zoom'
        ? 3.35
        : specialMode === 'marvel-intro' || specialMode === 'text-portal'
        ? title.trim()
          ? 3.15
          : 0
        : selectedTemplate.overlay === 'kinetic-intro' && (title.trim() || subtitle.trim())
        ? 1.0
        : 0;
    let cursor = introDur;

    for (const item of photos) {
      if (item.id === clipId) {
        const start = item.trimStart ?? 0;
        const end = item.trimEnd ?? item.sourceDuration ?? slideDur;
        const clampedOffset = Math.max(0, Math.min(sourceTimeSec - start, Math.max(0.05, end - start - 0.02)));
        scrubNonceRef.current += 1;
        setScrubRequest({ timeSec: cursor + clampedOffset, nonce: scrubNonceRef.current });
        return;
      }
      if (item.kind === 'video') {
        cursor += Math.max(0.3, (item.trimEnd ?? item.sourceDuration ?? 3) - (item.trimStart ?? 0));
      } else {
        cursor += slideDur;
      }
    }
  };

  const handleResetSamples = () => {
    setMediaError(null);
    setPhotos((prev) => {
      const revokedUrls = new Set<string>();
      prev.forEach((p) => {
        if (!p.isSample) {
          if (p.kind === 'photo') {
            URL.revokeObjectURL(p.previewUrl);
            rawFileMapRef.current.delete(p.id);
          } else if (p.videoUrl && !revokedUrls.has(p.videoUrl)) {
            revokedUrls.add(p.videoUrl);
            URL.revokeObjectURL(p.videoUrl);
          }
        }
      });
      return makeSampleGallery(selectedTemplate);
    });
    setExportedVideo(null);
  };

  const getSafeVideoFilename = (result: ExportVideoResult, copyNum = 1) => {
    const slug = selectedTemplate.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const stamp = String(Date.now()).slice(-5);
    const suffix = copyNum > 1 ? `-${copyNum}` : '';
    return `ReelCraft-${slug || 'status'}-${stamp}${suffix}.${result.extension}`;
  };

  const triggerBrowserDownload = (result: ExportVideoResult) => {
    downloadCopyCountRef.current += 1;
    const filename = getSafeVideoFilename(result, downloadCopyCountRef.current);
    // Use application/octet-stream to force file download instead of inline video preview on mobile/Safari
    const downloadBlob = new Blob([result.blob], { type: 'application/octet-stream' });
    const downloadUrl = URL.createObjectURL(downloadBlob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => {
      document.body.removeChild(link);
    }, 250);
    window.setTimeout(() => {
      URL.revokeObjectURL(downloadUrl);
    }, 60_000);
  };

  const runMp4EncodeAndDownload = async () => {
    if (decodedClips.length === 0) {
      setExportError('Wait a moment for your photos or videos to finish loading.');
      return;
    }

    setAwaitingAdConfirm(false);
    setExportError(null);
    setTelegramSendStatus(null);
    setDownloadNotice(null);
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
          clips: decodedClips,
          title,
          subtitle,
          pace,
          landscapeTilt,
          transitionOverride: transitionChoice,
          chromaSensitivity,
          presetOverlayClip,
          watermarkEnabled: appConfig.watermark_enabled,
          watermarkText: appConfig.watermark_text,
        },
        onProgress: setExportProgress,
        signal: abortController.signal,
      });

      setExportedVideo(result);
      hasCompletedExportRef.current = true;
      haptic('success');
      if (!tgContext.isTelegram) {
        triggerBrowserDownload(result);
      }
    } catch (err) {
      if (err instanceof Error && err.message !== 'Export cancelled') {
        setExportError(err.message || 'Could not prepare MP4 on this device.');
      }
    } finally {
      setIsExporting(false);
      exportAbortRef.current = null;
    }
  };

  const handleConfirmWatchAd = async () => {
    setExportError(null);
    setTelegramSendStatus(null);
    haptic('medium');

    if (shouldTriggerRewardAd(appConfig)) {
      muteAndPauseDomMedia();
      setIsRunningAd(true);
      const adResult = await runRewardedAd(appConfig);
      setIsRunningAd(false);
      if (adResult === 'cancelled') {
        setAwaitingAdConfirm(true);
        setExportError('Please finish watching the short ad to unlock your HD video download.');
        return;
      }
    }

    await runMp4EncodeAndDownload();
  };

  const handleDownloadVideoClick = async () => {
    setDownloadModalOpen(true);

    // If current edit is already rendered and ready, reopen the ready sheet immediately
    if (exportedVideo && !isExporting && !isRunningAd) {
      return;
    }

    if (decodedClips.length === 0) {
      setAwaitingAdConfirm(false);
      setExportError('Wait a moment for your photos or videos to finish loading.');
      return;
    }

    setExportError(null);
    setTelegramSendStatus(null);
    haptic('medium');

    // If AdsGram / rewarded ad is enabled in Admin, show "Watch Ad to Download" prompt first
    if (shouldTriggerRewardAd(appConfig)) {
      setAwaitingAdConfirm(true);
      return;
    }

    // Otherwise encode & download right away
    await runMp4EncodeAndDownload();
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

  const nativeShareSupported = useMemo(() => {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      return false;
    }
    if (typeof navigator.canShare === 'function' && typeof File !== 'undefined') {
      try {
        const probe = new File([new Uint8Array(1)], 'reel.mp4', { type: 'video/mp4' });
        return navigator.canShare({ files: [probe] });
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  const handleNativeShare = async () => {
    if (!exportedVideo) return;
    try {
      const file = new File([exportedVideo.blob], getSafeVideoFilename(exportedVideo), {
        type: exportedVideo.mimeType || 'video/mp4',
      });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: title.trim() || selectedTemplate.name,
        });
      }
    } catch {
      // User dismissed share sheet
    }
  };

  const handleDirectDownload = async () => {
    if (!exportedVideo) return;
    haptic('light');
    setDownloadNotice(null);

    const baseFileName = getSafeVideoFilename(exportedVideo, 1);

    // Inside Telegram Mini App, WebViews block <a href="blob:..." download>.
    // Prepare a short-lived signed HTTPS download URL and trigger Telegram's native downloadFile API
    // with a unique copy number + cache-buster on every click so Telegram always downloads a fresh file.
    if (tgContext.isTelegram) {
      downloadCopyCountRef.current += 1;
      const copyNum = downloadCopyCountRef.current;

      const buildAttemptDownload = (baseUrl: string, baseName: string) => {
        const sep = baseUrl.includes('?') ? '&' : '?';
        const attemptUrl =
          copyNum > 1
            ? `${baseUrl}${sep}copy=${copyNum}&t=${Date.now()}`
            : `${baseUrl}${sep}t=${Date.now()}`;
        const attemptName =
          copyNum > 1
            ? baseName.replace(/(\.[a-z0-9]+)$/i, `-${copyNum}$1`)
            : baseName;
        return { attemptUrl, attemptName };
      };

      const cached = preparedDownloadRef.current;
      if (cached && Date.now() < cached.expiresAt) {
        const { attemptUrl, attemptName } = buildAttemptDownload(cached.url, cached.fileName);
        const mode = triggerTelegramNativeDownload(attemptUrl, attemptName);
        if (mode !== 'unsupported') {
          setDownloadNotice(
            mode === 'native-dialog'
              ? `Tap Download in the Telegram popup to save ${attemptName}.`
              : 'Opening direct MP4 download in your browser...'
          );
          return;
        }
      }

      setIsPreparingDownload(true);
      try {
        const form = new FormData();
        form.append('video', exportedVideo.blob, baseFileName);
        form.append('initData', tgContext.initData);
        form.append('fileName', baseFileName);

        const res = await fetch('/api/prepare-download', {
          method: 'POST',
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          downloadUrl?: string;
          fileName?: string;
          error?: string;
        };

        if (!res.ok || !data.ok || !data.downloadUrl) {
          setDownloadNotice(
            data.error ||
              'Direct download unavailable right now. Tap "Send to My Telegram Chat" above to save instantly.'
          );
          return;
        }

        const resolvedBaseName = data.fileName || baseFileName;
        preparedDownloadRef.current = {
          url: data.downloadUrl,
          fileName: resolvedBaseName,
          expiresAt: Date.now() + 8 * 60 * 1000,
        };

        const { attemptUrl, attemptName } = buildAttemptDownload(
          data.downloadUrl,
          resolvedBaseName
        );
        const mode = triggerTelegramNativeDownload(attemptUrl, attemptName);
        haptic('success');
        if (mode === 'native-dialog') {
          setDownloadNotice(`Tap Download in the Telegram popup to save ${attemptName}.`);
        } else if (mode === 'external-browser') {
          setDownloadNotice('Opening MP4 download in your phone browser...');
        } else {
          window.location.href = attemptUrl;
          setDownloadNotice('Download started — check your Downloads folder.');
        }
      } catch {
        setDownloadNotice(
          'Could not start direct download. Tap "Send to My Telegram Chat" above to save to Gallery.'
        );
      } finally {
        setIsPreparingDownload(false);
      }
      return;
    }

    // Standard mobile & desktop browsers
    triggerBrowserDownload(exportedVideo);
    setDownloadNotice('Download started — check your browser Downloads folder.');
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

  if (shortsRoute.isShorts) {
    return (
      <ShortsFeedView
        appConfig={appConfig}
        tgContext={tgContext}
        initialVideoId={shortsRoute.initialVideoId}
        onOpenStudio={() => {
          window.history.pushState({}, '', '/');
          setShortsRoute({ isShorts: false, initialVideoId: '' });
          setView('templates');
        }}
      />
    );
  }

  const activeAdLabel = getActiveRewardAdLabel(appConfig);
  const isAnyAdOpen = isRunningAd || isRunningInterstitial;

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
              Editor
            </button>
          </nav>

          {/* Zone 3: Download Video (Photos Edit only — never shown on Templates tab) */}
          <div className="shrink-0">
            {view === 'edit' ? (
              <button
                type="button"
                onClick={handleDownloadVideoClick}
                className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 active:scale-[0.98] flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download Video</span>
              </button>
            ) : (
              <div className="w-2" aria-hidden="true" />
            )}
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
                customTemplates={customTemplates}
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
                    Open Editor →
                  </button>
                </div>

                <VideoPreviewStage
                  template={selectedTemplate}
                  images={decodedFrames}
                  clips={decodedClips}
                  title={title}
                  subtitle={subtitle}
                  pace={pace}
                  landscapeTilt={landscapeTilt}
                  transitionOverride={transitionChoice}
                  chromaSensitivity={chromaSensitivity}
                  presetOverlayClip={presetOverlayClip}
                  watermarkEnabled={appConfig.watermark_enabled}
                  watermarkText={appConfig.watermark_text}
                  isExporting={isExporting}
                  pausePlayback={isAnyAdOpen}
                />
              </div>
            </aside>
          </div>
        </main>
      )}

      {/* VIEW 2: CAPCUT / INSHOT ZERO-SCROLL MEDIA EDIT STUDIO */}
      {view === 'edit' && (
        <main className="flex-1 min-h-0 max-w-7xl w-full mx-auto flex flex-col lg:grid lg:grid-cols-12 lg:gap-8 lg:px-6 lg:py-6 overflow-hidden">
          {/* Always-visible Live Video Stage (Top half on mobile, Left column on desktop) */}
          <div className="flex-1 min-h-0 px-4 pt-3 pb-2 lg:p-0 lg:col-span-6 flex flex-col items-center justify-center overflow-hidden">
            <VideoPreviewStage
              template={selectedTemplate}
              images={decodedFrames}
              clips={decodedClips}
              title={title}
              subtitle={subtitle}
              pace={pace}
              landscapeTilt={landscapeTilt}
              transitionOverride={transitionChoice}
              chromaSensitivity={chromaSensitivity}
              presetOverlayClip={presetOverlayClip}
              watermarkEnabled={appConfig.watermark_enabled}
              watermarkText={appConfig.watermark_text}
              isExporting={isExporting}
              pausePlayback={isAnyAdOpen}
              scrubRequest={scrubRequest}
              fillViewport
            />
          </div>

          {/* Instant Thumb-Zone Edit Dock (Pinned directly below video on mobile, Right column on desktop) */}
          <div className="shrink-0 lg:col-span-6 lg:flex lg:flex-col lg:justify-center pb-safe lg:pb-0">
            <div className="hidden lg:flex items-center justify-between mb-4 px-1">
              <div>
                <h1 className="text-xl font-bold text-white">Media Studio</h1>
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
              chromaSensitivity={chromaSensitivity}
              isLoadingMedia={isLoadingMedia}
              mediaError={mediaError}
              onAddPhotos={handleAddPhotos}
              onAddVideos={handleAddVideos}
              onSetGreenScreenVideo={handleSetGreenScreenVideo}
              onRemovePhoto={handleRemovePhoto}
              onMovePhoto={handleMovePhoto}
              onTrimClip={handleTrimClip}
              onSplitClip={handleSplitClip}
              onScrubClipTime={handleScrubClipTime}
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
              onChromaSensitivityChange={(val) => {
                setChromaSensitivity(val);
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
              <span className="text-[11px] font-medium">Editor</span>
            </button>
          </div>
        </nav>
      )}

      {/* Download Video Sheet (Watch Ad Prompt → Ad → HD MP4 Auto-Download / Send to Telegram) */}
      <DownloadVideoModal
        open={downloadModalOpen}
        templateName={selectedTemplate.name}
        adProviderLabel={activeAdLabel}
        isTelegram={tgContext.isTelegram}
        awaitingAdConfirm={awaitingAdConfirm}
        isRunningAd={isRunningAd}
        isExporting={isExporting}
        exportProgress={exportProgress}
        exportError={exportError}
        exportedVideo={exportedVideo}
        isSendingTelegram={isSendingTelegram}
        isPreparingDownload={isPreparingDownload}
        telegramSendStatus={telegramSendStatus}
        downloadNotice={downloadNotice}
        nativeShareSupported={nativeShareSupported}
        onConfirmWatchAd={handleConfirmWatchAd}
        onDirectDownload={handleDirectDownload}
        onRetry={() => {
          setExportedVideo(null);
          handleDownloadVideoClick();
        }}
        onCancelExport={() => exportAbortRef.current?.abort()}
        onClose={() => {
          const finishedExport = Boolean(exportedVideo);
          setAwaitingAdConfirm(false);
          setDownloadNotice(null);
          setDownloadModalOpen(false);
          if (finishedExport) {
            void triggerInterstitialWithCooldown();
          }
        }}
        onSendToTelegramChat={handleSendToTelegramChat}
        onNativeShare={handleNativeShare}
      />
    </div>
  );
}
