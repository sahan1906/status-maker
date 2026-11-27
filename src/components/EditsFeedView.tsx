import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Film,
  Heart,
  Loader2,
  Play,
  RefreshCw,
  Share2,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { PaceMode, REEL_TEMPLATES, ReelTemplate } from '../data/templates';
import {
  getActiveRewardAdLabel,
  PublicAppConfig,
  runShortsSwipeAd,
  shouldTriggerShortsSwipeAd,
} from '../lib/adNetworks';
import {
  buildEditsTelegramDirectLink,
  haptic,
  openTelegramShareUrl,
  TelegramContextInfo,
} from '../lib/telegram';
import {
  FrameImage,
  getTotalDuration,
  loadOrientedImage,
  renderFrame,
} from '../lib/videoRenderer';

export interface ShortReelItem {
  id: string;
  title: string;
  video_url: string;
  poster_url: string;
  tags: string;
  tag_list: string[];
  likes: number;
  comments_count: number;
  created_at: string;
}

export type EditFeedItem =
  | {
      kind: 'template';
      id: string;
      template: ReelTemplate;
      title: string;
      subtitle: string;
      posterUrl: string;
      baseLikes: number;
    }
  | {
      kind: 'video';
      id: string;
      video: ShortReelItem;
      title: string;
      subtitle: string;
      posterUrl: string;
      baseLikes: number;
    };

interface EditsFeedViewProps {
  appConfig: PublicAppConfig;
  tgContext: TelegramContextInfo;
  customTemplates: ReelTemplate[];
  watermarkEnabled: boolean;
  watermarkText: string;
  initialVideoId: string;
  initialTemplateId: string;
  embedded?: boolean;
  onUseTemplate: (template: ReelTemplate) => void;
  onOpenStudio: () => void;
}

const LIKED_STORAGE_KEY = 'reelcraft_edits_liked_v1';
const MUTED_STORAGE_KEY = 'reelcraft_edits_muted_v1';
const EDITS_AD_LAST_SHOWN_KEY = 'reelcraft_edits_ad_last_shown_v1';
const EDITS_AD_COOLDOWN_MS = 60 * 60 * 1000; // Strictly max 1 ad per hour in Edits tab
const INITIAL_PAGE_LIMIT = 20;
const NEXT_PAGE_LIMIT = 20;
const MAX_BLOB_CACHE_ITEMS = 6;
const MAX_PREFETCH_BYTES = 18 * 1024 * 1024;

const templateImageCache = new Map<string, Promise<FrameImage>>();

function getCachedTemplateImage(url: string): Promise<FrameImage> {
  const existing = templateImageCache.get(url);
  if (existing) return existing;
  const promise = loadOrientedImage(url);
  templateImageCache.set(url, promise);
  return promise;
}

function formatCompactCount(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.max(0, Math.floor(num)));
}

function deterministicTemplateLikes(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 997;
  }
  return 180 + (hash % 740);
}

function loadLikedSet(): Set<string> {
  try {
    const raw = window.localStorage.getItem(LIKED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveLikedSet(set: Set<string>): void {
  try {
    window.localStorage.setItem(LIKED_STORAGE_KEY, JSON.stringify(Array.from(set).slice(-500)));
  } catch {
    // Ignore storage errors
  }
}

function loadInitialMuted(): boolean {
  try {
    const raw = window.localStorage.getItem(MUTED_STORAGE_KEY);
    if (raw === 'false') return false;
  } catch {
    // Default muted for instant autoplay
  }
  return true;
}

function getLastEditsAdShownAt(): number {
  try {
    const raw = window.localStorage.getItem(EDITS_AD_LAST_SHOWN_KEY);
    const ts = Number(raw || '0');
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  } catch {
    return 0;
  }
}

function recordEditsAdShownNow(): void {
  try {
    window.localStorage.setItem(EDITS_AD_LAST_SHOWN_KEY, String(Date.now()));
  } catch {
    // Ignore storage errors
  }
}

interface TemplateStageProps {
  template: ReelTemplate;
  isActive: boolean;
  isNear: boolean;
  isPaused: boolean;
  watermarkEnabled: boolean;
  watermarkText: string;
  progressFillRef: React.MutableRefObject<HTMLDivElement | null>;
  onSurfaceTap: () => void;
}

function TemplateStage({
  template,
  isActive,
  isNear,
  isPaused,
  watermarkEnabled,
  watermarkText,
  progressFillRef,
  onSurfaceTap,
}: TemplateStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const presetVideoRef = useRef<HTMLVideoElement | null>(null);
  const [images, setImages] = useState<FrameImage[]>([]);

  useEffect(() => {
    if (!isNear || template.presetOverlayUrl) return;
    let cancelled = false;
    Promise.all(
      template.samplePhotos.map((u) => getCachedTemplateImage(u).catch(() => null))
    ).then((res) => {
      if (cancelled) return;
      setImages(res.filter((img): img is FrameImage => img !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [isNear, template.presetOverlayUrl, template.samplePhotos]);

  // Animate live 9:16 template canvas when active; draw crisp first frame when adjacent
  useEffect(() => {
    if (template.presetOverlayUrl) return;
    const canvas = canvasRef.current;
    if (!canvas || images.length === 0) return;
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
    const dur = Math.max(0.5, getTotalDuration(config));

    if (!isActive || isPaused) {
      renderFrame(ctx, 0.45 % dur, config);
      return;
    }

    let raf = 0;
    let lastDraw = 0;
    const startMs = performance.now();

    const tick = (now: number) => {
      if (now - lastDraw >= 33) {
        lastDraw = now;
        const elapsed = ((now - startMs) / 1000) % dur;
        renderFrame(ctx, elapsed, config);
        if (progressFillRef.current) {
          progressFillRef.current.style.transform = `scaleX(${Math.max(0, Math.min(1, elapsed / dur))})`;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [
    images,
    isActive,
    isPaused,
    progressFillRef,
    template,
    watermarkEnabled,
    watermarkText,
  ]);

  // Sync preset AI overlay video playback if template uses presetOverlayUrl
  useEffect(() => {
    const vid = presetVideoRef.current;
    if (!vid) return;
    if (isActive && !isPaused) {
      vid.play().catch(() => {});
    } else if (!vid.paused) {
      vid.pause();
    }
  }, [isActive, isPaused]);

  if (template.presetOverlayUrl) {
    return (
      <div className="relative h-full w-full bg-[#08080A]" onClick={onSurfaceTap}>
        {isNear && (
          <video
            ref={presetVideoRef}
            src={template.presetOverlayUrl}
            muted
            loop
            playsInline
            preload={isActive ? 'auto' : 'metadata'}
            className="h-full w-full object-cover cursor-pointer"
          />
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-[#08080A] cursor-pointer" onClick={onSurfaceTap}>
      {template.samplePhotos[0] && (
        <img
          src={template.samplePhotos[0]}
          alt={template.name}
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover opacity-80"
        />
      )}
      <canvas
        ref={canvasRef}
        width={450}
        height={800}
        className="relative h-full w-full block object-cover"
        aria-label={`Live preview of ${template.name}`}
      />
    </div>
  );
}

export function EditsFeedView({
  appConfig,
  tgContext,
  customTemplates,
  watermarkEnabled,
  watermarkText,
  initialVideoId,
  initialTemplateId,
  embedded = false,
  onUseTemplate,
  onOpenStudio,
}: EditsFeedViewProps) {
  const sessionSeedRef = useRef<string>(String(Math.floor(10000 + Math.random() * 899999)));
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const slideRefs = useRef<Map<number, HTMLElement>>(new Map());
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const progressFillRef = useRef<HTMLDivElement | null>(null);

  const [channelVideos, setChannelVideos] = useState<ShortReelItem[]>([]);
  const [hasMoreVideos, setHasMoreVideos] = useState<boolean>(false);
  const [videoOffset, setVideoOffset] = useState<number>(0);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);

  const [feedFilter, setFeedFilter] = useState<'all' | 'templates' | 'videos'>('all');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(() => loadInitialMuted());
  const [pausedMap, setPausedMap] = useState<Record<string, boolean>>({});
  const [readyIds, setReadyIds] = useState<Record<string, boolean>>({});
  const [bufferingId, setBufferingId] = useState<string | null>(null);
  const [videoErrorIds, setVideoErrorIds] = useState<Record<string, boolean>>({});

  // Background RAM blob prefetcher for uploaded channel videos
  const blobUrlsRef = useRef<Map<string, string>>(new Map());
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});
  const failedPrefetchRef = useRef<Set<string>>(new Set());
  const startedDirectIdsRef = useRef<Set<string>>(new Set());
  const preloadedPostersRef = useRef<Set<string>>(new Set());

  const [likedIds, setLikedIds] = useState<Set<string>>(() => loadLikedSet());
  const [heartBurstId, setHeartBurstId] = useState<string | null>(null);
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  const singleTapTimerRef = useRef<number | null>(null);

  // Hourly 1-scroll ad gate state (max 1 ad per hour in Edits tab)
  const [adGateLocked, setAdGateLocked] = useState<boolean>(false);
  const [isRunningGateAd, setIsRunningGateAd] = useState<boolean>(false);
  const [gateAdMsg, setGateAdMsg] = useState<string | null>(null);
  const seenSlideIdsRef = useRef<Set<string>>(new Set());

  // Toast feedback
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMsg(null), 2200);
  }, []);

  // Revoke cached blob URLs on unmount
  useEffect(() => {
    const cache = blobUrlsRef.current;
    return () => {
      cache.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Ignore revoke errors
        }
      });
      cache.clear();
    };
  }, []);

  const fetchChannelVideos = useCallback(async (nextOffset: number, replace: boolean) => {
    if (!replace) setIsLoadingMore(true);
    const batchLimit = replace ? INITIAL_PAGE_LIMIT : NEXT_PAGE_LIMIT;
    try {
      const res = await fetch(
        `/api/shorts?limit=${batchLimit}&offset=${nextOffset}&seed=${encodeURIComponent(sessionSeedRef.current)}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as {
        videos?: ShortReelItem[];
        has_more?: boolean;
      };
      const incoming = Array.isArray(data.videos) ? data.videos : [];
      setHasMoreVideos(Boolean(data.has_more));
      setVideoOffset(nextOffset + incoming.length);
      setChannelVideos((prev) => {
        const base = replace ? [] : prev;
        const existingIds = new Set(base.map((v) => v.id));
        const deduped = incoming.filter((v) => !existingIds.has(v.id));
        return [...base, ...deduped];
      });
    } catch {
      // Built-in templates still display immediately even if channel feed is empty/offline
    } finally {
      if (!replace) setIsLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchChannelVideos(0, true);
  }, [fetchChannelVideos]);

  // Build unified feed: all Templates + all private-channel uploaded videos
  const allFeedItems = useMemo<EditFeedItem[]>(() => {
    const templatePool: ReelTemplate[] = [...customTemplates, ...REEL_TEMPLATES];
    const templateItems: EditFeedItem[] = templatePool.map((tpl) => ({
      kind: 'template',
      id: `tpl-${tpl.id}`,
      template: tpl,
      title: tpl.name,
      subtitle: `${tpl.badge} · ${tpl.tagline}`,
      posterUrl: tpl.samplePhotos[0] || '',
      baseLikes: deterministicTemplateLikes(tpl.id),
    }));

    const videoItems: EditFeedItem[] = channelVideos.map((v) => ({
      kind: 'video',
      id: v.id,
      video: v,
      title: v.title,
      subtitle: (v.tag_list || []).slice(0, 3).join(' · '),
      posterUrl: v.poster_url,
      baseLikes: v.likes,
    }));

    if (feedFilter === 'templates') {
      if (initialTemplateId) {
        const idx = templateItems.findIndex(
          (item) => item.kind === 'template' && item.template.id === initialTemplateId
        );
        if (idx > 0) {
          return [...templateItems.slice(idx), ...templateItems.slice(0, idx)];
        }
      }
      return templateItems;
    }

    if (feedFilter === 'videos') {
      if (initialVideoId) {
        const idx = videoItems.findIndex((item) => item.id === initialVideoId);
        if (idx > 0) {
          return [...videoItems.slice(idx), ...videoItems.slice(0, idx)];
        }
      }
      return videoItems;
    }

    // Filter === 'all':
    // 1. If a specific template was tapped from the Templates tab, start directly on THAT template
    let orderedTemplates = templateItems;
    if (initialTemplateId) {
      const idx = templateItems.findIndex(
        (item) => item.kind === 'template' && item.template.id === initialTemplateId
      );
      if (idx > 0) {
        orderedTemplates = [...templateItems.slice(idx), ...templateItems.slice(0, idx)];
      }
    }

    let orderedVideos = videoItems;
    if (initialVideoId) {
      const idx = videoItems.findIndex((item) => item.id === initialVideoId);
      if (idx > 0) {
        orderedVideos = [...videoItems.slice(idx), ...videoItems.slice(0, idx)];
      }
    }

    if (orderedVideos.length === 0) {
      return orderedTemplates;
    }

    // If deep-linked to a specific uploaded video, put it at slide 0
    const merged: EditFeedItem[] = [];
    let tIdx = 0;
    let vIdx = 0;

    if (initialVideoId && orderedVideos[0]?.id === initialVideoId) {
      merged.push(orderedVideos[0]);
      vIdx = 1;
    }

    // Interleave cleanly: 2 templates, then 1 uploaded AI-prompt/channel video
    while (tIdx < orderedTemplates.length || vIdx < orderedVideos.length) {
      for (let k = 0; k < 2 && tIdx < orderedTemplates.length; k += 1) {
        merged.push(orderedTemplates[tIdx]);
        tIdx += 1;
      }
      if (vIdx < orderedVideos.length) {
        merged.push(orderedVideos[vIdx]);
        vIdx += 1;
      }
    }

    return merged;
  }, [channelVideos, customTemplates, feedFilter, initialTemplateId, initialVideoId]);

  // Reset scroll to top when switching entry target or filter
  useEffect(() => {
    setActiveIndex(0);
    seenSlideIdsRef.current = new Set();
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [feedFilter, initialTemplateId, initialVideoId]);

  const activeItem = allFeedItems[activeIndex] || null;
  const activeVideoReady =
    activeItem?.kind === 'video' ? Boolean(readyIds[activeItem.id]) : true;

  // Fetch more channel videos when nearing the end
  useEffect(() => {
    if (
      !isLoadingMore &&
      hasMoreVideos &&
      allFeedItems.length > 0 &&
      activeIndex >= allFeedItems.length - 5
    ) {
      fetchChannelVideos(videoOffset, false);
    }
  }, [activeIndex, allFeedItems.length, fetchChannelVideos, hasMoreVideos, isLoadingMore, videoOffset]);

  // Preload poster images for upcoming slides
  useEffect(() => {
    if (allFeedItems.length === 0) return;
    for (let i = activeIndex; i <= Math.min(allFeedItems.length - 1, activeIndex + 5); i += 1) {
      const poster = allFeedItems[i]?.posterUrl;
      if (poster && !preloadedPostersRef.current.has(poster)) {
        preloadedPostersRef.current.add(poster);
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.src = poster;
      }
    }
  }, [activeIndex, allFeedItems]);

  // Sequential background RAM prefetcher for upcoming uploaded channel videos
  useEffect(() => {
    if (allFeedItems.length === 0 || adGateLocked) return;

    const controller = new AbortController();
    let timerId: number | null = null;

    const runPrefetch = async () => {
      const upcomingVideos = allFeedItems
        .slice(activeIndex + 1, activeIndex + 4)
        .filter((item): item is Extract<EditFeedItem, { kind: 'video' }> => item.kind === 'video');

      for (const item of upcomingVideos) {
        if (controller.signal.aborted) return;
        if (blobUrlsRef.current.has(item.id) || failedPrefetchRef.current.has(item.id)) {
          continue;
        }
        try {
          const res = await fetch(item.video.video_url, {
            signal: controller.signal,
            mode: 'cors',
            cache: 'force-cache',
          });
          if (!res.ok) {
            failedPrefetchRef.current.add(item.id);
            continue;
          }
          const len = Number(res.headers.get('Content-Length') || '0');
          if (len > MAX_PREFETCH_BYTES) {
            failedPrefetchRef.current.add(item.id);
            continue;
          }
          const blob = await res.blob();
          if (controller.signal.aborted) return;
          if (blob.size === 0 || blob.size > MAX_PREFETCH_BYTES) {
            failedPrefetchRef.current.add(item.id);
            continue;
          }

          const objectUrl = URL.createObjectURL(blob);
          blobUrlsRef.current.set(item.id, objectUrl);

          const keepIds = new Set(
            allFeedItems
              .slice(Math.max(0, activeIndex - 1), activeIndex + 5)
              .map((entry) => entry.id)
          );
          if (blobUrlsRef.current.size > MAX_BLOB_CACHE_ITEMS) {
            for (const [cachedId, cachedUrl] of blobUrlsRef.current.entries()) {
              if (blobUrlsRef.current.size <= MAX_BLOB_CACHE_ITEMS) break;
              if (!keepIds.has(cachedId)) {
                URL.revokeObjectURL(cachedUrl);
                blobUrlsRef.current.delete(cachedId);
              }
            }
          }
          setBlobUrls(Object.fromEntries(blobUrlsRef.current.entries()));
        } catch {
          if (!controller.signal.aborted) {
            failedPrefetchRef.current.add(item.id);
          }
        }
      }
    };

    if (activeVideoReady) {
      runPrefetch();
    } else {
      timerId = window.setTimeout(runPrefetch, 1500);
    }

    return () => {
      controller.abort();
      if (timerId) window.clearTimeout(timerId);
    };
  }, [activeIndex, activeVideoReady, adGateLocked, allFeedItems]);

  // Track active slide via IntersectionObserver
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || allFeedItems.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let bestIdx = -1;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
            const idx = Number((entry.target as HTMLElement).dataset.index);
            if (Number.isFinite(idx)) {
              bestRatio = entry.intersectionRatio;
              bestIdx = idx;
            }
          }
        }
        if (bestIdx >= 0 && bestRatio >= 0.65) {
          setActiveIndex((prev) => (prev === bestIdx ? prev : bestIdx));
        }
      },
      { root, threshold: [0.65, 0.85] }
    );

    slideRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [allFeedItems]);

  // Hourly 1-scroll Ad Rule: triggers after user scrolls once in Edits, max ONCE per hour
  useEffect(() => {
    if (!activeItem) return;
    if (!seenSlideIdsRef.current.has(activeItem.id)) {
      seenSlideIdsRef.current.add(activeItem.id);
      if (seenSlideIdsRef.current.size >= 2 && shouldTriggerShortsSwipeAd(appConfig)) {
        const elapsedSinceLastAd = Date.now() - getLastEditsAdShownAt();
        if (elapsedSinceLastAd >= EDITS_AD_COOLDOWN_MS) {
          setGateAdMsg(null);
          setAdGateLocked(true);
        }
      }
    }
  }, [activeItem, appConfig]);

  // Sync uploaded channel <video> playback so only active slide plays
  useEffect(() => {
    const activeVideoId = activeItem?.kind === 'video' ? activeItem.id : '';

    videoRefs.current.forEach((videoEl, id) => {
      videoEl.muted = isMuted;
      const userPaused = Boolean(pausedMap[id]);
      if (id === activeVideoId && !adGateLocked && !userPaused) {
        if (!blobUrlsRef.current.has(id)) {
          startedDirectIdsRef.current.add(id);
        }
        const playPromise = videoEl.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {
            if (!videoEl.muted) {
              videoEl.muted = true;
              setIsMuted(true);
              videoEl.play().catch(() => {});
            }
          });
        }
      } else {
        if (!videoEl.paused) {
          videoEl.pause();
        }
        if (id !== activeVideoId && videoEl.currentTime > 0.25) {
          try {
            videoEl.currentTime = 0;
          } catch {
            // Ignore seek errors
          }
        }
      }
    });
  }, [activeItem, adGateLocked, blobUrls, isMuted, pausedMap]);

  // Smooth bottom progress bar for uploaded channel videos
  useEffect(() => {
    if (activeItem?.kind !== 'video') return;
    let rafId = 0;
    const tick = () => {
      const fill = progressFillRef.current;
      const vid = videoRefs.current.get(activeItem.id);
      if (fill) {
        if (vid && Number.isFinite(vid.duration) && vid.duration > 0) {
          const ratio = Math.max(0, Math.min(1, vid.currentTime / vid.duration));
          fill.style.transform = `scaleX(${ratio})`;
        } else {
          fill.style.transform = 'scaleX(0)';
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [activeItem]);

  const scrollToIndex = useCallback(
    (targetIdx: number) => {
      if (adGateLocked) return;
      const clamped = Math.max(0, Math.min(allFeedItems.length - 1, targetIdx));
      const el = slideRefs.current.get(clamped);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [adGateLocked, allFeedItems.length]
  );

  const toggleMute = useCallback(() => {
    haptic('light');
    setIsMuted((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(MUTED_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const togglePlayPause = useCallback((itemId: string) => {
    setPausedMap((prev) => ({ ...prev, [itemId]: !prev[itemId] }));
  }, []);

  // Desktop keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (adGateLocked) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        scrollToIndex(activeIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        scrollToIndex(activeIndex - 1);
      } else if (e.key === ' ') {
        e.preventDefault();
        if (activeItem) togglePlayPause(activeItem.id);
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggleMute();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, activeItem, adGateLocked, scrollToIndex, toggleMute, togglePlayPause]);

  const handleToggleLike = useCallback(
    (item: EditFeedItem, forceLikeOnly = false) => {
      const alreadyLiked = likedIds.has(item.id);
      if (forceLikeOnly && alreadyLiked) {
        setHeartBurstId(item.id);
        window.setTimeout(() => setHeartBurstId((cur) => (cur === item.id ? null : cur)), 650);
        return;
      }

      const nextLiked = !alreadyLiked;
      haptic(nextLiked ? 'medium' : 'light');

      setLikedIds((prev) => {
        const next = new Set(prev);
        if (nextLiked) next.add(item.id);
        else next.delete(item.id);
        saveLikedSet(next);
        return next;
      });

      if (nextLiked) {
        setHeartBurstId(item.id);
        window.setTimeout(() => setHeartBurstId((cur) => (cur === item.id ? null : cur)), 650);
      }

      if (item.kind === 'video') {
        setChannelVideos((prev) =>
          prev.map((v) =>
            v.id === item.id ? { ...v, likes: Math.max(0, v.likes + (nextLiked ? 1 : -1)) } : v
          )
        );
        fetch('/api/shorts-like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            video_id: item.id,
            action: nextLiked ? 'like' : 'unlike',
          }),
        }).catch(() => {
          // Optimistic UI remains intact
        });
      }
    },
    [likedIds]
  );

  const handleSurfaceTap = useCallback(
    (item: EditFeedItem) => {
      const now = Date.now();
      const prev = lastTapRef.current;

      if (prev && prev.id === item.id && now - prev.at < 280) {
        if (singleTapTimerRef.current) {
          window.clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        lastTapRef.current = null;
        handleToggleLike(item, true);
        return;
      }

      lastTapRef.current = { id: item.id, at: now };
      singleTapTimerRef.current = window.setTimeout(() => {
        togglePlayPause(item.id);
        singleTapTimerRef.current = null;
      }, 240);
    },
    [handleToggleLike, togglePlayPause]
  );

  const handleShare = useCallback(
    async (item: EditFeedItem) => {
      haptic('light');
      const shareLink = buildEditsTelegramDirectLink(
        appConfig.telegram_bot_username,
        appConfig.telegram_miniapp_short_name,
        item.kind === 'template' ? { templateId: item.template.id } : { videoId: item.id }
      );
      const shareText = `${item.title} — Watch on ${appConfig.site_name}`;

      if (tgContext.isTelegram && openTelegramShareUrl(shareLink, shareText)) {
        return;
      }

      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: item.title, text: shareText, url: shareLink });
          return;
        } catch {
          // Fall through to clipboard
        }
      }

      try {
        await navigator.clipboard.writeText(shareLink);
        showToast('Direct link copied');
      } catch {
        showToast('Share link ready');
      }
    },
    [
      appConfig.site_name,
      appConfig.telegram_bot_username,
      appConfig.telegram_miniapp_short_name,
      showToast,
      tgContext.isTelegram,
    ]
  );

  const handleUnlockHourlyGate = useCallback(async () => {
    if (isRunningGateAd) return;
    haptic('light');
    setIsRunningGateAd(true);
    setGateAdMsg(null);
    try {
      const outcome = await runShortsSwipeAd(appConfig);
      if (outcome === 'cancelled') {
        setGateAdMsg('Please finish the short ad to continue browsing Edits.');
        return;
      }
      recordEditsAdShownNow();
      setAdGateLocked(false);
      haptic('success');
    } catch {
      recordEditsAdShownNow();
      setAdGateLocked(false);
    } finally {
      setIsRunningGateAd(false);
    }
  }, [appConfig, isRunningGateAd]);

  const adLabel = getActiveRewardAdLabel(appConfig);
  const upNextItems = useMemo(
    () => allFeedItems.slice(activeIndex + 1, activeIndex + 5),
    [allFeedItems, activeIndex]
  );

  const getDisplayLikes = (item: EditFeedItem) => {
    if (item.kind === 'video') return item.video.likes;
    return item.baseLikes + (likedIds.has(item.id) ? 1 : 0);
  };

  return (
    <div
      className={`w-full bg-[#08080A] text-[#F4F4F5] overflow-hidden flex flex-col lg:flex-row lg:items-center lg:justify-center lg:gap-10 lg:px-8 ${
        embedded ? 'flex-1 min-h-0 pb-14 md:pb-0' : 'h-[100dvh]'
      }`}
    >
      {/* Main 9:16 Vertical Stage */}
      <div
        className={`relative flex-1 lg:flex-none w-full h-full lg:rounded-3xl lg:border lg:border-white/10 lg:shadow-2xl overflow-hidden bg-[#08080A] ${
          embedded
            ? 'lg:h-[min(calc(100dvh-5.5rem),820px)] lg:w-[min(450px,50dvh)]'
            : 'lg:h-[min(92dvh,860px)] lg:w-[min(460px,52dvh)]'
        }`}
      >
        {/* Compact Top Floating Bar (Strictly <= 10% mobile viewport height) */}
        <header className="absolute top-0 inset-x-0 z-30 pointer-events-none bg-gradient-to-b from-black/80 via-black/40 to-transparent pt-3 pb-5 px-3.5">
          <div className="flex items-center justify-between gap-2 pointer-events-auto">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-bold tracking-tight text-white whitespace-nowrap shrink-0">
                Edits
              </span>
              <span className="text-[11px] font-mono tabular-nums text-zinc-400 whitespace-nowrap shrink-0">
                · {allFeedItems.length}
              </span>
            </div>

            {channelVideos.length > 0 && (
              <div className="flex items-center gap-1 bg-black/50 backdrop-blur-md p-0.5 rounded-xl border border-white/10">
                {(
                  [
                    { id: 'all', label: 'All' },
                    { id: 'templates', label: 'Templates' },
                    { id: 'videos', label: 'AI Edits' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      haptic('light');
                      setFeedFilter(tab.id);
                    }}
                    className={`min-h-[30px] px-2.5 text-[11px] font-semibold rounded-lg whitespace-nowrap transition-colors ${
                      feedFilter === tab.id
                        ? 'bg-amber-400 text-[#08080A]'
                        : 'text-zinc-300 hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        {/* Vertical Snap-Scroll Edits Feed */}
        <div
          ref={scrollContainerRef}
          className={`h-full w-full snap-y snap-mandatory no-scrollbar ${
            adGateLocked ? 'overflow-hidden' : 'overflow-y-scroll'
          }`}
        >
          {allFeedItems.map((item, idx) => {
            const isNear = idx >= activeIndex - 1 && idx <= activeIndex + 1;
            const isActive = idx === activeIndex;
            const isLiked = likedIds.has(item.id);
            const isPaused = Boolean(pausedMap[item.id]);
            const hasErr = item.kind === 'video' && Boolean(videoErrorIds[item.id]);
            const isReady = item.kind === 'template' || Boolean(readyIds[item.id]);

            const cachedBlob = item.kind === 'video' ? blobUrls[item.id] : undefined;
            const resolvedSrc =
              item.kind === 'video'
                ? cachedBlob && (!isActive || !startedDirectIdsRef.current.has(item.id))
                  ? cachedBlob
                  : item.video.video_url
                : '';

            const preloadMode = isActive ? 'auto' : cachedBlob ? 'auto' : 'none';

            return (
              <section
                key={item.id}
                data-index={idx}
                ref={(node) => {
                  if (node) slideRefs.current.set(idx, node);
                  else slideRefs.current.delete(idx);
                }}
                className="relative h-full w-full snap-start snap-always bg-[#08080A] select-none overflow-hidden"
              >
                {item.kind === 'template' ? (
                  <TemplateStage
                    template={item.template}
                    isActive={isActive && !adGateLocked}
                    isNear={isNear}
                    isPaused={isPaused}
                    watermarkEnabled={watermarkEnabled}
                    watermarkText={watermarkText}
                    progressFillRef={progressFillRef}
                    onSurfaceTap={() => handleSurfaceTap(item)}
                  />
                ) : (
                  <>
                    {/* Instant Poster Backdrop for uploaded channel videos */}
                    {item.posterUrl ? (
                      <img
                        src={item.posterUrl}
                        alt={item.title}
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 h-full w-full object-cover bg-[#08080A]"
                      />
                    ) : (
                      <div className="absolute inset-0 bg-[#0E0E12]" />
                    )}

                    {isNear && (
                      <video
                        ref={(el) => {
                          if (el) videoRefs.current.set(item.id, el);
                          else videoRefs.current.delete(item.id);
                        }}
                        src={resolvedSrc}
                        poster={item.posterUrl || undefined}
                        playsInline
                        loop
                        muted={isMuted}
                        preload={preloadMode}
                        onClick={() => handleSurfaceTap(item)}
                        onLoadedData={() => {
                          setReadyIds((prev) =>
                            prev[item.id] ? prev : { ...prev, [item.id]: true }
                          );
                        }}
                        onCanPlay={() => {
                          setReadyIds((prev) =>
                            prev[item.id] ? prev : { ...prev, [item.id]: true }
                          );
                          setBufferingId((cur) => (cur === item.id ? null : cur));
                        }}
                        onWaiting={() => {
                          if (isActive) setBufferingId(item.id);
                        }}
                        onPlaying={() => {
                          setReadyIds((prev) =>
                            prev[item.id] ? prev : { ...prev, [item.id]: true }
                          );
                          setBufferingId((cur) => (cur === item.id ? null : cur));
                          setVideoErrorIds((prev) =>
                            prev[item.id] ? { ...prev, [item.id]: false } : prev
                          );
                        }}
                        onError={() => {
                          setBufferingId((cur) => (cur === item.id ? null : cur));
                          setVideoErrorIds((prev) => ({ ...prev, [item.id]: true }));
                        }}
                        className={`relative h-full w-full object-cover cursor-pointer transition-opacity duration-200 ${
                          isReady ? 'opacity-100' : 'opacity-0'
                        }`}
                      />
                    )}
                  </>
                )}

                {/* Buffering Spinner (only for uploaded channel videos while cold-loading) */}
                {item.kind === 'video' &&
                  isActive &&
                  (!isReady || bufferingId === item.id) &&
                  !isPaused &&
                  !hasErr && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
                      <div className="w-12 h-12 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center">
                        <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
                      </div>
                    </div>
                  )}

                {/* Paused Indicator */}
                {isActive && isPaused && !adGateLocked && !hasErr && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
                    <div className="w-16 h-16 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center">
                      <Play className="w-7 h-7 text-white fill-white ml-0.5" />
                    </div>
                  </div>
                )}

                {/* Double-Tap Heart Burst */}
                {heartBurstId === item.id && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-20">
                    <Heart className="w-20 h-20 text-rose-500 fill-rose-500 drop-shadow-lg animate-ping" />
                  </div>
                )}

                {/* Video Stream Retry Overlay */}
                {hasErr && (
                  <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center gap-3 px-6 text-center z-10">
                    <p className="text-sm font-medium text-zinc-200">Video stream interrupted</p>
                    <button
                      type="button"
                      onClick={() => {
                        setVideoErrorIds((prev) => ({ ...prev, [item.id]: false }));
                        const el = videoRefs.current.get(item.id);
                        if (el) {
                          el.load();
                          el.play().catch(() => {});
                        }
                      }}
                      className="min-h-[44px] px-4 text-xs font-semibold rounded-xl bg-white text-[#08080A] flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Retry Video</span>
                    </button>
                  </div>
                )}

                {/* Measured Bottom Contrast Scrim */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/90 via-black/45 to-transparent z-10" />

                {/* Right-Side Thumb-Zone Action Rail (Minimal & Clean) */}
                <div className="absolute right-3 bottom-16 z-20 flex flex-col items-center gap-4">
                  {/* Like */}
                  <button
                    type="button"
                    onClick={() => handleToggleLike(item)}
                    aria-label={isLiked ? 'Unlike edit' : 'Like edit'}
                    className="min-w-[48px] min-h-[48px] flex flex-col items-center justify-center gap-1 active:scale-90 transition-transform"
                  >
                    <span className="w-11 h-11 rounded-full bg-black/45 backdrop-blur-md flex items-center justify-center">
                      <Heart
                        className={`w-6 h-6 transition-colors ${
                          isLiked ? 'text-rose-500 fill-rose-500' : 'text-white'
                        }`}
                      />
                    </span>
                    <span className="text-[11px] font-mono tabular-nums font-medium text-white drop-shadow">
                      {formatCompactCount(getDisplayLikes(item))}
                    </span>
                  </button>

                  {/* Share */}
                  <button
                    type="button"
                    onClick={() => handleShare(item)}
                    aria-label="Share edit"
                    className="min-w-[48px] min-h-[48px] flex flex-col items-center justify-center gap-1 active:scale-90 transition-transform"
                  >
                    <span className="w-11 h-11 rounded-full bg-black/45 backdrop-blur-md flex items-center justify-center">
                      <Share2 className="w-5 h-5 text-white" />
                    </span>
                    <span className="text-[11px] font-medium text-zinc-100 drop-shadow">
                      Share
                    </span>
                  </button>

                  {/* Sound Toggle (only for uploaded channel videos that have audio) */}
                  {item.kind === 'video' && (
                    <button
                      type="button"
                      onClick={toggleMute}
                      aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
                      className="min-w-[44px] min-h-[44px] flex items-center justify-center active:scale-90 transition-transform"
                    >
                      <span className="w-10 h-10 rounded-full bg-black/45 backdrop-blur-md flex items-center justify-center">
                        {isMuted ? (
                          <VolumeX className="w-5 h-5 text-zinc-200" />
                        ) : (
                          <Volume2 className="w-5 h-5 text-amber-400" />
                        )}
                      </span>
                    </button>
                  )}
                </div>

                {/* Bottom-Left Metadata + "Use this Edit" CTA (Templates ONLY — never shown on uploaded AI prompt videos) */}
                <div className="absolute left-4 right-20 bottom-6 z-20 space-y-2.5 pb-safe">
                  <div className="space-y-1">
                    <h2 className="text-[15px] font-semibold leading-snug text-white line-clamp-2 drop-shadow">
                      {item.title}
                    </h2>
                    {item.subtitle && (
                      <p className="text-xs text-zinc-300 line-clamp-2 drop-shadow">
                        {item.subtitle}
                      </p>
                    )}
                  </div>

                  {item.kind === 'template' && (
                    <button
                      type="button"
                      onClick={() => {
                        haptic('medium');
                        onUseTemplate(item.template);
                      }}
                      className="min-h-[42px] px-4 py-2 text-xs font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 active:scale-[0.98] inline-flex items-center gap-1.5 shadow-lg transition whitespace-nowrap"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Use this Edit</span>
                    </button>
                  )}
                </div>
              </section>
            );
          })}

          {isLoadingMore && (
            <div className="h-24 flex items-center justify-center gap-2 text-xs text-zinc-400">
              <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
              <span>Loading more edits...</span>
            </div>
          )}
        </div>

        {/* Bottom Playback Progress Bar (GPU scaleX) */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2.5px] bg-white/15 z-30">
          <div
            ref={progressFillRef}
            className="h-full w-full origin-left bg-amber-400"
            style={{ transform: 'scaleX(0)' }}
          />
        </div>

        {/* Hourly 1-Scroll Ad Gate Overlay (Shown max 1 time per hour in Edits tab) */}
        {adGateLocked && (
          <div className="absolute inset-0 z-40 bg-black/85 backdrop-blur-md flex items-center justify-center p-6">
            <div className="w-full max-w-xs rounded-3xl bg-[#111114] border border-white/15 p-6 text-center space-y-5 shadow-2xl">
              <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-400/15 border border-amber-400/25 flex items-center justify-center">
                <Play className="w-5 h-5 text-amber-400 fill-amber-400 ml-0.5" />
              </div>

              <div className="space-y-1.5">
                <h3 className="text-lg font-bold text-white">Continue Browsing Edits</h3>
                <p className="text-xs leading-relaxed text-zinc-400">
                  Watch 1 quick {adLabel} ad to unlock ad-free Edits scrolling for the next hour.
                </p>
              </div>

              {gateAdMsg && (
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2">
                  {gateAdMsg}
                </p>
              )}

              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={handleUnlockHourlyGate}
                  disabled={isRunningGateAd}
                  className="w-full min-h-[48px] px-4 text-sm font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 disabled:opacity-60 active:scale-[0.98] flex items-center justify-center gap-2 transition"
                >
                  {isRunningGateAd ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Loading Ad...</span>
                    </>
                  ) : (
                    <span>Watch Short Ad &amp; Continue</span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    haptic('light');
                    onOpenStudio();
                  }}
                  className="w-full min-h-[42px] px-4 text-xs font-medium rounded-xl text-zinc-300 hover:text-white hover:bg-white/[0.06] transition"
                >
                  Back to Templates
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Transient Toast */}
        {toastMsg && (
          <div className="pointer-events-none absolute top-20 inset-x-0 z-50 flex justify-center px-4">
            <div className="px-3.5 py-2 rounded-xl bg-zinc-900/95 border border-white/15 text-xs font-medium text-white shadow-lg flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>{toastMsg}</span>
            </div>
          </div>
        )}
      </div>

      {/* Desktop Theatre Side Rail */}
      <aside className="hidden lg:flex flex-col w-80 h-[min(calc(100dvh-5.5rem),820px)] rounded-3xl bg-[#111114] border border-white/10 p-6 justify-between shrink-0">
        <div className="space-y-6 overflow-y-auto no-scrollbar">
          <div className="space-y-1">
            <h1 className="text-lg font-bold text-white">{appConfig.site_name} Edits</h1>
            <p className="text-xs text-zinc-400">
              {allFeedItems.length} live edits · Scroll or use arrow keys
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={activeIndex <= 0 || adGateLocked}
              onClick={() => scrollToIndex(activeIndex - 1)}
              className="min-h-[44px] px-3 text-xs font-semibold rounded-xl bg-white/[0.06] border border-white/10 text-zinc-200 hover:bg-white/[0.12] disabled:opacity-40 flex items-center justify-center gap-1.5 transition"
            >
              <ArrowUp className="w-4 h-4" />
              <span>Previous</span>
            </button>
            <button
              type="button"
              disabled={activeIndex >= allFeedItems.length - 1 || adGateLocked}
              onClick={() => scrollToIndex(activeIndex + 1)}
              className="min-h-[44px] px-3 text-xs font-semibold rounded-xl bg-white/[0.06] border border-white/10 text-zinc-200 hover:bg-white/[0.12] disabled:opacity-40 flex items-center justify-center gap-1.5 transition"
            >
              <ArrowDown className="w-4 h-4" />
              <span>Next</span>
            </button>
          </div>

          {upNextItems.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-white/10">
              <p className="text-xs font-semibold text-zinc-400">Up Next</p>
              <div className="space-y-2">
                {upNextItems.map((item, offsetIdx) => {
                  const targetIdx = activeIndex + 1 + offsetIdx;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={adGateLocked}
                      onClick={() => scrollToIndex(targetIdx)}
                      className="w-full p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 flex items-center gap-3 text-left transition disabled:opacity-40"
                    >
                      <div className="w-10 h-14 rounded-lg bg-zinc-900 overflow-hidden shrink-0">
                        {item.posterUrl ? (
                          <img
                            src={item.posterUrl}
                            alt={item.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Film className="w-4 h-4 text-zinc-600" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-zinc-100 line-clamp-2">
                          {item.title}
                        </p>
                        <p className="text-[11px] font-mono tabular-nums text-zinc-500 mt-0.5">
                          {item.kind === 'template' ? 'Template' : 'AI Edit'} ·{' '}
                          {formatCompactCount(getDisplayLikes(item))} likes
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="pt-4 border-t border-white/10 space-y-3">
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>Shortcuts</span>
            <span className="font-mono text-zinc-400">↑ ↓ · Space</span>
          </div>
          {activeItem?.kind === 'template' ? (
            <button
              type="button"
              onClick={() => onUseTemplate(activeItem.template)}
              className="w-full min-h-[44px] px-4 text-xs font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 flex items-center justify-center gap-1.5 transition"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Use this Edit</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenStudio}
              className="w-full min-h-[44px] px-4 text-xs font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 flex items-center justify-center gap-1.5 transition"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Browse All Templates</span>
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
