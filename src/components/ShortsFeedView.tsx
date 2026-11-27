import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  Film,
  Heart,
  Loader2,
  Play,
  RefreshCw,
  Share2,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  getActiveRewardAdLabel,
  PublicAppConfig,
  runRewardedAd,
  runShortsSwipeAd,
  shouldTriggerRewardAd,
  shouldTriggerShortsSwipeAd,
} from '../lib/adNetworks';
import {
  buildShortsTelegramDirectLink,
  haptic,
  openTelegramShareUrl,
  TelegramContextInfo,
  triggerTelegramNativeDownload,
} from '../lib/telegram';

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

interface ShortsFeedViewProps {
  appConfig: PublicAppConfig;
  tgContext: TelegramContextInfo;
  initialVideoId: string;
  onOpenStudio: () => void;
}

const LIKED_STORAGE_KEY = 'reelcraft_shorts_liked_v1';
const MUTED_STORAGE_KEY = 'reelcraft_shorts_muted_v1';
const PAGE_LIMIT = 20;

function formatCompactCount(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.max(0, Math.floor(num)));
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
    // Ignore storage quota errors
  }
}

function loadInitialMuted(): boolean {
  try {
    const raw = window.localStorage.getItem(MUTED_STORAGE_KEY);
    if (raw === 'false') return false;
  } catch {
    // Default muted for smooth mobile autoplay
  }
  return true;
}

export function ShortsFeedView({
  appConfig,
  tgContext,
  initialVideoId,
  onOpenStudio,
}: ShortsFeedViewProps) {
  const sessionSeedRef = useRef<string>(String(Math.floor(10000 + Math.random() * 899999)));
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const slideRefs = useRef<Map<number, HTMLElement>>(new Map());
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const progressFillRef = useRef<HTMLDivElement | null>(null);

  const [videos, setVideos] = useState<ShortReelItem[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [offset, setOffset] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeTag, setActiveTag] = useState<string>('all');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(() => loadInitialMuted());
  const [pausedMap, setPausedMap] = useState<Record<string, boolean>>({});
  const [bufferingId, setBufferingId] = useState<string | null>(null);
  const [videoErrorIds, setVideoErrorIds] = useState<Record<string, boolean>>({});

  const [likedIds, setLikedIds] = useState<Set<string>>(() => loadLikedSet());
  const [heartBurstId, setHeartBurstId] = useState<string | null>(null);
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  const singleTapTimerRef = useRef<number | null>(null);

  // N-swipe ad gate state (default 5, configurable 3-10 in /admin)
  const swipesPerAd = Math.max(3, Math.min(10, Number(appConfig.shorts_ad_every_n) || 5));
  const [adGateLocked, setAdGateLocked] = useState<boolean>(false);
  const [isRunningGateAd, setIsRunningGateAd] = useState<boolean>(false);
  const [gateAdMsg, setGateAdMsg] = useState<string | null>(null);
  const seenSlideIdsRef = useRef<Set<string>>(new Set());
  const swipesSinceAdRef = useRef<number>(0);

  // Download sheet (gated by 1 rewarded ad)
  const [downloadTarget, setDownloadTarget] = useState<ShortReelItem | null>(null);
  const [isRunningDownloadAd, setIsRunningDownloadAd] = useState<boolean>(false);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);

  // Toast feedback (Share / Like / Download)
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMsg(null), 2400);
  }, []);

  const fetchBatch = useCallback(
    async (nextOffset: number, replace: boolean) => {
      if (replace) {
        setIsLoading(true);
        setLoadError(null);
      } else {
        setIsLoadingMore(true);
      }

      try {
        const res = await fetch(
          `/api/reels?limit=${PAGE_LIMIT}&offset=${nextOffset}&seed=${encodeURIComponent(sessionSeedRef.current)}`,
          { cache: 'no-store' }
        );
        const data = (await res.json().catch(() => ({}))) as {
          videos?: ShortReelItem[];
          total?: number;
          has_more?: boolean;
          error?: string;
        };

        if (!res.ok) {
          throw new Error(data.error || 'Could not load Shorts feed.');
        }

        const incoming = Array.isArray(data.videos) ? data.videos : [];
        setTotalCount(typeof data.total === 'number' ? data.total : incoming.length);
        setHasMore(Boolean(data.has_more));
        setOffset(nextOffset + incoming.length);

        setVideos((prev) => {
          const base = replace ? [] : prev;
          const existingIds = new Set(base.map((v) => v.id));
          const deduped = incoming.filter((v) => !existingIds.has(v.id));
          const merged = [...base, ...deduped];

          // If deep-linked via ?startapp=short_<id> or /shorts?v=<id>, promote matching video to top
          if (replace && initialVideoId) {
            const matchIdx = merged.findIndex((v) => v.id === initialVideoId);
            if (matchIdx > 0) {
              const [found] = merged.splice(matchIdx, 1);
              merged.unshift(found);
            }
          }
          return merged;
        });
      } catch (err) {
        if (replace) {
          setLoadError(err instanceof Error ? err.message : 'Could not load Shorts feed.');
        }
      } finally {
        if (replace) setIsLoading(false);
        else setIsLoadingMore(false);
      }
    },
    [initialVideoId]
  );

  useEffect(() => {
    fetchBatch(0, true);
  }, [fetchBatch]);

  // Extract top unique tags for clean horizontal filter strip
  const availableTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of videos) {
      for (const tag of v.tag_list || []) {
        const key = tag.toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7)
      .map(([tag]) => tag);
  }, [videos]);

  const filteredVideos = useMemo(() => {
    if (activeTag === 'all') return videos;
    return videos.filter((v) =>
      (v.tag_list || []).some((t) => t.toLowerCase() === activeTag.toLowerCase())
    );
  }, [videos, activeTag]);

  const activeVideo = filteredVideos[activeIndex] || null;

  // Prefetch next batch when within 5 videos of the end
  useEffect(() => {
    if (
      !isLoading &&
      !isLoadingMore &&
      hasMore &&
      filteredVideos.length > 0 &&
      activeIndex >= filteredVideos.length - 5
    ) {
      fetchBatch(offset, false);
    }
  }, [activeIndex, filteredVideos.length, hasMore, isLoading, isLoadingMore, offset, fetchBatch]);

  // Track active slide via IntersectionObserver
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || filteredVideos.length === 0) return;

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
  }, [filteredVideos]);

  // Count unique video views toward the N-swipe ad gate
  useEffect(() => {
    if (!activeVideo) return;
    if (!seenSlideIdsRef.current.has(activeVideo.id)) {
      seenSlideIdsRef.current.add(activeVideo.id);
      // Do not count the very first reel on initial open as a swipe
      if (seenSlideIdsRef.current.size > 1) {
        swipesSinceAdRef.current += 1;
        if (
          shouldTriggerShortsSwipeAd(appConfig) &&
          swipesSinceAdRef.current >= swipesPerAd
        ) {
          setGateAdMsg(null);
          setAdGateLocked(true);
        }
      }
    }
  }, [activeVideo, appConfig, swipesPerAd]);

  // Synchronize video playback: ONLY active reel plays (and pauses when ad gate or download sheet is open)
  useEffect(() => {
    const shouldPauseAll = adGateLocked || Boolean(downloadTarget);
    const activeId = activeVideo?.id || '';

    videoRefs.current.forEach((videoEl, id) => {
      videoEl.muted = isMuted;
      const userPaused = Boolean(pausedMap[id]);
      if (id === activeId && !shouldPauseAll && !userPaused) {
        const playPromise = videoEl.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {
            // Autoplay blocked with sound -> fallback to muted playback smoothly
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
        if (id !== activeId && videoEl.currentTime > 0.25) {
          try {
            videoEl.currentTime = 0;
          } catch {
            // Ignore seek errors while unloading
          }
        }
      }
    });
  }, [activeVideo, adGateLocked, downloadTarget, isMuted, pausedMap]);

  // Smooth GPU-composited bottom playback progress bar for active reel
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const fill = progressFillRef.current;
      const vid = activeVideo ? videoRefs.current.get(activeVideo.id) : null;
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
  }, [activeVideo]);

  const scrollToIndex = useCallback(
    (targetIdx: number) => {
      if (adGateLocked) return;
      const clamped = Math.max(0, Math.min(filteredVideos.length - 1, targetIdx));
      const el = slideRefs.current.get(clamped);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [adGateLocked, filteredVideos.length]
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

  const togglePlayPause = useCallback((videoId: string) => {
    setPausedMap((prev) => ({ ...prev, [videoId]: !prev[videoId] }));
  }, []);

  // Desktop keyboard navigation (ArrowUp, ArrowDown, Space, M)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (adGateLocked || downloadTarget) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        scrollToIndex(activeIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        scrollToIndex(activeIndex - 1);
      } else if (e.key === ' ') {
        e.preventDefault();
        if (activeVideo) togglePlayPause(activeVideo.id);
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggleMute();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, activeVideo, adGateLocked, downloadTarget, scrollToIndex, toggleMute, togglePlayPause]);

  const handleToggleLike = useCallback(
    (video: ShortReelItem, forceLikeOnly = false) => {
      const alreadyLiked = likedIds.has(video.id);
      if (forceLikeOnly && alreadyLiked) {
        setHeartBurstId(video.id);
        window.setTimeout(() => setHeartBurstId((cur) => (cur === video.id ? null : cur)), 650);
        return;
      }

      const nextLiked = !alreadyLiked;
      haptic(nextLiked ? 'medium' : 'light');

      setLikedIds((prev) => {
        const next = new Set(prev);
        if (nextLiked) next.add(video.id);
        else next.delete(video.id);
        saveLikedSet(next);
        return next;
      });

      setVideos((prev) =>
        prev.map((item) =>
          item.id === video.id
            ? { ...item, likes: Math.max(0, item.likes + (nextLiked ? 1 : -1)) }
            : item
        )
      );

      if (nextLiked) {
        setHeartBurstId(video.id);
        window.setTimeout(() => setHeartBurstId((cur) => (cur === video.id ? null : cur)), 650);
      }

      fetch('/api/reels-like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: video.id,
          action: nextLiked ? 'like' : 'unlike',
        }),
      }).catch(() => {
        // Optimistic UI remains intact
      });
    },
    [likedIds]
  );

  const handleVideoSurfaceTap = useCallback(
    (video: ShortReelItem) => {
      const now = Date.now();
      const prev = lastTapRef.current;

      if (prev && prev.id === video.id && now - prev.at < 280) {
        if (singleTapTimerRef.current) {
          window.clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        lastTapRef.current = null;
        handleToggleLike(video, true);
        return;
      }

      lastTapRef.current = { id: video.id, at: now };
      singleTapTimerRef.current = window.setTimeout(() => {
        togglePlayPause(video.id);
        singleTapTimerRef.current = null;
      }, 240);
    },
    [handleToggleLike, togglePlayPause]
  );

  const handleShare = useCallback(
    async (video: ShortReelItem) => {
      haptic('light');
      const shareLink = buildShortsTelegramDirectLink(
        appConfig.telegram_bot_username,
        appConfig.telegram_miniapp_short_name,
        video.id
      );
      const shareText = `${video.title} — Watch on ${appConfig.site_name}`;

      if (tgContext.isTelegram && openTelegramShareUrl(shareLink, shareText)) {
        return;
      }

      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: video.title, text: shareText, url: shareLink });
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

  const handleUnlockSwipeGate = useCallback(async () => {
    if (isRunningGateAd) return;
    haptic('light');
    setIsRunningGateAd(true);
    setGateAdMsg(null);
    try {
      const outcome = await runShortsSwipeAd(appConfig);
      if (outcome === 'cancelled') {
        setGateAdMsg('Please finish the short ad to unlock the next reels.');
        return;
      }
      swipesSinceAdRef.current = 0;
      setAdGateLocked(false);
      haptic('success');
    } catch {
      swipesSinceAdRef.current = 0;
      setAdGateLocked(false);
    } finally {
      setIsRunningGateAd(false);
    }
  }, [appConfig, isRunningGateAd]);

  const triggerReelDownload = useCallback(
    (video: ShortReelItem) => {
      const safeSlug = video.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 42);
      const fileName = `${safeSlug || 'short-reel'}.mp4`;
      const downloadUrl = `${window.location.origin}/api/reels-download?url=${encodeURIComponent(
        video.video_url
      )}&title=${encodeURIComponent(video.title)}`;

      if (tgContext.isTelegram) {
        const res = triggerTelegramNativeDownload(downloadUrl, fileName);
        if (res !== 'unsupported') {
          showToast('Saving reel...');
          return;
        }
      }

      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast('Download started');
    },
    [showToast, tgContext.isTelegram]
  );

  const handleConfirmDownload = useCallback(async () => {
    if (!downloadTarget || isRunningDownloadAd) return;
    const needsAd =
      appConfig.shorts_download_ad_enabled && shouldTriggerRewardAd(appConfig);

    if (!needsAd) {
      const target = downloadTarget;
      setDownloadTarget(null);
      triggerReelDownload(target);
      return;
    }

    haptic('light');
    setIsRunningDownloadAd(true);
    setDownloadMsg(null);
    try {
      const outcome = await runRewardedAd(appConfig);
      if (outcome === 'cancelled') {
        setDownloadMsg('Finish the short ad to unlock this download.');
        return;
      }
      const target = downloadTarget;
      setDownloadTarget(null);
      haptic('success');
      triggerReelDownload(target);
    } catch {
      const target = downloadTarget;
      setDownloadTarget(null);
      triggerReelDownload(target);
    } finally {
      setIsRunningDownloadAd(false);
    }
  }, [appConfig, downloadTarget, isRunningDownloadAd, triggerReelDownload]);

  const handleSelectTag = useCallback((tag: string) => {
    haptic('light');
    setActiveTag(tag);
    setActiveIndex(0);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, []);

  const adLabel = getActiveRewardAdLabel(appConfig);
  const upNextVideos = useMemo(
    () => filteredVideos.slice(activeIndex + 1, activeIndex + 5),
    [filteredVideos, activeIndex]
  );

  return (
    <div className="h-[100dvh] w-full bg-[#08080A] text-[#F4F4F5] overflow-hidden flex flex-col lg:flex-row lg:items-center lg:justify-center lg:gap-10 lg:px-8">
      {/* Main 9:16 Vertical Stage (Full-bleed on Mobile, Theatre Frame on Desktop) */}
      <div className="relative flex-1 lg:flex-none w-full h-full lg:h-[min(92dvh,860px)] lg:w-[min(460px,52dvh)] lg:rounded-3xl lg:border lg:border-white/10 lg:shadow-2xl overflow-hidden bg-[#08080A]">
        {/* Compact Top Floating Bar (Strictly <= 10% mobile viewport height) */}
        <header className="absolute top-0 inset-x-0 z-30 pointer-events-none bg-gradient-to-b from-black/80 via-black/40 to-transparent pt-3 pb-5 px-3.5">
          <div className="flex items-center justify-between gap-2 pointer-events-auto">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-bold tracking-tight text-white whitespace-nowrap shrink-0">
                Shorts
              </span>
              {totalCount > 0 && (
                <span className="text-[11px] font-mono tabular-nums text-zinc-400 whitespace-nowrap shrink-0">
                  · {totalCount}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                haptic('light');
                onOpenStudio();
              }}
              className="min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-xl bg-white/10 hover:bg-white/20 backdrop-blur-md text-white flex items-center gap-1.5 transition whitespace-nowrap shrink-0"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>Editor</span>
            </button>
          </div>

          {availableTags.length > 0 && (
            <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar pointer-events-auto">
              <button
                type="button"
                onClick={() => handleSelectTag('all')}
                className={`min-h-[32px] px-3 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                  activeTag === 'all'
                    ? 'bg-amber-400 text-[#08080A] font-semibold'
                    : 'bg-black/45 text-zinc-200 hover:bg-black/70 backdrop-blur-sm'
                }`}
              >
                All
              </button>
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleSelectTag(tag)}
                  className={`min-h-[32px] px-3 text-xs font-medium rounded-lg capitalize whitespace-nowrap shrink-0 transition-colors ${
                    activeTag === tag
                      ? 'bg-amber-400 text-[#08080A] font-semibold'
                      : 'bg-black/45 text-zinc-200 hover:bg-black/70 backdrop-blur-sm'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </header>

        {/* Loading State */}
        {isLoading && (
          <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-[#08080A] px-6 text-center">
            <Loader2 className="w-7 h-7 animate-spin text-amber-400" />
            <p className="text-sm font-medium text-zinc-300">Loading shorts feed...</p>
          </div>
        )}

        {/* Error State */}
        {!isLoading && loadError && videos.length === 0 && (
          <div className="h-full w-full flex flex-col items-center justify-center gap-4 px-6 text-center">
            <Film className="w-9 h-9 text-zinc-500" />
            <div className="space-y-1 max-w-xs">
              <p className="text-sm font-semibold text-white">Feed unavailable right now</p>
              <p className="text-xs text-zinc-400">{loadError}</p>
            </div>
            <button
              type="button"
              onClick={() => fetchBatch(0, true)}
              className="min-h-[44px] px-5 text-xs font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 flex items-center gap-2 transition"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Try Again</span>
            </button>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && !loadError && filteredVideos.length === 0 && (
          <div className="h-full w-full flex flex-col items-center justify-center gap-4 px-6 text-center">
            <Film className="w-9 h-9 text-zinc-500" />
            <div className="space-y-1 max-w-xs">
              <p className="text-sm font-semibold text-white">No shorts found</p>
              <p className="text-xs text-zinc-400">
                {activeTag !== 'all'
                  ? `No reels tagged "${activeTag}" in this batch.`
                  : 'Create your own 9:16 edit in the studio.'}
              </p>
            </div>
            {activeTag !== 'all' ? (
              <button
                type="button"
                onClick={() => handleSelectTag('all')}
                className="min-h-[44px] px-5 text-xs font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 transition"
              >
                Show All Shorts
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenStudio}
                className="min-h-[44px] px-5 text-xs font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 transition"
              >
                Open Studio Editor
              </button>
            )}
          </div>
        )}

        {/* Vertical Snap-Scroll Reels Container */}
        {!isLoading && filteredVideos.length > 0 && (
          <div
            ref={scrollContainerRef}
            className={`h-full w-full snap-y snap-mandatory no-scrollbar ${
              adGateLocked ? 'overflow-hidden' : 'overflow-y-scroll'
            }`}
          >
            {filteredVideos.map((video, idx) => {
              const isNearActive = Math.abs(idx - activeIndex) <= 2;
              const isActive = idx === activeIndex;
              const isLiked = likedIds.has(video.id);
              const isPaused = Boolean(pausedMap[video.id]);
              const hasErr = Boolean(videoErrorIds[video.id]);

              return (
                <section
                  key={video.id}
                  data-index={idx}
                  ref={(node) => {
                    if (node) slideRefs.current.set(idx, node);
                    else slideRefs.current.delete(idx);
                  }}
                  className="relative h-full w-full snap-start snap-always bg-[#08080A] select-none overflow-hidden"
                >
                  {/* Video Surface: Direct streaming without crossOrigin attribute */}
                  {isNearActive ? (
                    <video
                      ref={(el) => {
                        if (el) videoRefs.current.set(video.id, el);
                        else videoRefs.current.delete(video.id);
                      }}
                      src={video.video_url}
                      poster={video.poster_url || undefined}
                      playsInline
                      loop
                      muted={isMuted}
                      preload={isActive || idx === activeIndex + 1 ? 'auto' : 'metadata'}
                      onClick={() => handleVideoSurfaceTap(video)}
                      onWaiting={() => {
                        if (isActive) setBufferingId(video.id);
                      }}
                      onPlaying={() => {
                        setBufferingId((cur) => (cur === video.id ? null : cur));
                        setVideoErrorIds((prev) => (prev[video.id] ? { ...prev, [video.id]: false } : prev));
                      }}
                      onError={() => {
                        setBufferingId((cur) => (cur === video.id ? null : cur));
                        setVideoErrorIds((prev) => ({ ...prev, [video.id]: true }));
                      }}
                      className="h-full w-full object-cover bg-[#08080A] cursor-pointer"
                    />
                  ) : video.poster_url ? (
                    <img
                      src={video.poster_url}
                      alt={video.title}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover bg-[#08080A]"
                    />
                  ) : (
                    <div className="h-full w-full bg-[#0E0E12]" />
                  )}

                  {/* Center Buffering Spinner */}
                  {isActive && bufferingId === video.id && !isPaused && !hasErr && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="w-12 h-12 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
                        <Loader2 className="w-6 h-6 animate-spin text-white" />
                      </div>
                    </div>
                  )}

                  {/* Center Paused Indicator */}
                  {isActive && isPaused && !adGateLocked && !hasErr && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="w-16 h-16 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center">
                        <Play className="w-7 h-7 text-white fill-white ml-0.5" />
                      </div>
                    </div>
                  )}

                  {/* Double-tap Heart Burst */}
                  {heartBurstId === video.id && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <Heart className="w-20 h-20 text-rose-500 fill-rose-500 drop-shadow-lg animate-ping" />
                    </div>
                  )}

                  {/* Video Stream Error Retry Overlay */}
                  {hasErr && (
                    <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center gap-3 px-6 text-center z-10">
                      <p className="text-sm font-medium text-zinc-200">Video stream interrupted</p>
                      <button
                        type="button"
                        onClick={() => {
                          setVideoErrorIds((prev) => ({ ...prev, [video.id]: false }));
                          const el = videoRefs.current.get(video.id);
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

                  {/* Measured Bottom Contrast Scrim (4.5:1 text legibility over bright edits) */}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-60 bg-gradient-to-t from-black/90 via-black/45 to-transparent z-10" />

                  {/* Right-Side Thumb-Zone Action Rail (Lower 40%, >= 44px targets) */}
                  <div className="absolute right-3 bottom-16 z-20 flex flex-col items-center gap-3.5">
                    {/* Like */}
                    <button
                      type="button"
                      onClick={() => handleToggleLike(video)}
                      aria-label={isLiked ? 'Unlike reel' : 'Like reel'}
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
                        {formatCompactCount(video.likes)}
                      </span>
                    </button>

                    {/* Share (Telegram Direct Link) */}
                    <button
                      type="button"
                      onClick={() => handleShare(video)}
                      aria-label="Share reel"
                      className="min-w-[48px] min-h-[48px] flex flex-col items-center justify-center gap-1 active:scale-90 transition-transform"
                    >
                      <span className="w-11 h-11 rounded-full bg-black/45 backdrop-blur-md flex items-center justify-center">
                        <Share2 className="w-5 h-5 text-white" />
                      </span>
                      <span className="text-[11px] font-medium text-zinc-100 drop-shadow">
                        Share
                      </span>
                    </button>

                    {/* Download / Save (Rewarded Ad) */}
                    <button
                      type="button"
                      onClick={() => {
                        haptic('light');
                        setDownloadMsg(null);
                        setDownloadTarget(video);
                      }}
                      aria-label="Download reel"
                      className="min-w-[48px] min-h-[48px] flex flex-col items-center justify-center gap-1 active:scale-90 transition-transform"
                    >
                      <span className="w-11 h-11 rounded-full bg-black/45 backdrop-blur-md flex items-center justify-center">
                        <Download className="w-5 h-5 text-white" />
                      </span>
                      <span className="text-[11px] font-medium text-zinc-100 drop-shadow">
                        Save
                      </span>
                    </button>

                    {/* Sound Toggle */}
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
                  </div>

                  {/* Bottom-Left Metadata + Creator Conversion CTA (Zero-pill discipline) */}
                  <div className="absolute left-4 right-20 bottom-6 z-20 space-y-2.5 pb-safe">
                    <div className="space-y-1">
                      <h2 className="text-[15px] font-semibold leading-snug text-white line-clamp-2 drop-shadow">
                        {video.title}
                      </h2>
                      {(video.tag_list.length > 0 || video.comments_count > 0) && (
                        <p className="text-xs text-zinc-300 truncate">
                          {[
                            ...video.tag_list.slice(0, 3),
                            video.comments_count > 0
                              ? `${formatCompactCount(video.comments_count)} comments`
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        haptic('light');
                        onOpenStudio();
                      }}
                      className="min-h-[40px] px-4 py-2 text-xs font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 active:scale-[0.98] inline-flex items-center gap-1.5 shadow-lg transition whitespace-nowrap"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Use as Template / Edit</span>
                    </button>
                  </div>
                </section>
              );
            })}

            {isLoadingMore && (
              <div className="h-24 flex items-center justify-center gap-2 text-xs text-zinc-400">
                <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                <span>Loading more shorts...</span>
              </div>
            )}
          </div>
        )}

        {/* Thin Bottom Playback Progress Bar (GPU scaleX) */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2.5px] bg-white/15 z-30">
          <div
            ref={progressFillRef}
            className="h-full w-full origin-left bg-amber-400"
            style={{ transform: 'scaleX(0)' }}
          />
        </div>

        {/* N-Swipe Ad Unlock Gate Overlay */}
        {adGateLocked && (
          <div className="absolute inset-0 z-40 bg-black/85 backdrop-blur-md flex items-center justify-center p-6">
            <div className="w-full max-w-xs rounded-3xl bg-[#111114] border border-white/15 p-6 text-center space-y-5 shadow-2xl">
              <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-400/15 border border-amber-400/25 flex items-center justify-center">
                <Play className="w-5 h-5 text-amber-400 fill-amber-400 ml-0.5" />
              </div>

              <div className="space-y-1.5">
                <h3 className="text-lg font-bold text-white">Continue Watching</h3>
                <p className="text-xs leading-relaxed text-zinc-400">
                  Watch 1 short {adLabel} ad to unlock the next{' '}
                  <span className="font-mono tabular-nums text-zinc-200">{swipesPerAd}</span> reels.
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
                  onClick={handleUnlockSwipeGate}
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
                  Open Video Editor Studio
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Rewarded Ad Download Bottom Sheet */}
        {downloadTarget && (
          <div
            className="absolute inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-end justify-center"
            onClick={() => !isRunningDownloadAd && setDownloadTarget(null)}
          >
            <div
              className="w-full rounded-t-3xl bg-[#111114] border-t border-white/15 p-5 pb-safe space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-10 h-1 bg-zinc-700 rounded-full mx-auto" />

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-white">Save Short Video</h3>
                  <p className="text-xs text-zinc-400 mt-0.5 truncate">{downloadTarget.title}</p>
                </div>
                <button
                  type="button"
                  disabled={isRunningDownloadAd}
                  onClick={() => setDownloadTarget(null)}
                  aria-label="Close save sheet"
                  className="min-w-[40px] min-h-[40px] rounded-xl text-zinc-400 hover:text-white hover:bg-white/10 flex items-center justify-center shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-zinc-300 leading-relaxed">
                {appConfig.shorts_download_ad_enabled && shouldTriggerRewardAd(appConfig)
                  ? `Watch 1 quick ${adLabel} rewarded ad to save this HD MP4 directly to your device.`
                  : 'Save this HD MP4 directly to your device.'}
              </p>

              {downloadMsg && (
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2">
                  {downloadMsg}
                </p>
              )}

              <button
                type="button"
                onClick={handleConfirmDownload}
                disabled={isRunningDownloadAd}
                className="w-full min-h-[48px] px-4 text-sm font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 disabled:opacity-60 active:scale-[0.98] flex items-center justify-center gap-2 transition"
              >
                {isRunningDownloadAd ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Opening Ad...</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>
                      {appConfig.shorts_download_ad_enabled && shouldTriggerRewardAd(appConfig)
                        ? 'Watch Ad & Download MP4'
                        : 'Download MP4'}
                    </span>
                  </>
                )}
              </button>
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

      {/* Desktop Theatre Side Rail (Prevents narrow strip collapse on 1440px screens) */}
      <aside className="hidden lg:flex flex-col w-80 h-[min(92dvh,860px)] rounded-3xl bg-[#111114] border border-white/10 p-6 justify-between shrink-0">
        <div className="space-y-6 overflow-y-auto no-scrollbar">
          <div className="space-y-1">
            <h1 className="text-lg font-bold text-white">{appConfig.site_name} Shorts</h1>
            <p className="text-xs text-zinc-400">
              {totalCount > 0 ? `${totalCount} reels live` : 'Vertical AI edits feed'} · Swipe or use arrow keys
            </p>
          </div>

          {/* Desktop Prev / Next Controls */}
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
              disabled={activeIndex >= filteredVideos.length - 1 || adGateLocked}
              onClick={() => scrollToIndex(activeIndex + 1)}
              className="min-h-[44px] px-3 text-xs font-semibold rounded-xl bg-white/[0.06] border border-white/10 text-zinc-200 hover:bg-white/[0.12] disabled:opacity-40 flex items-center justify-center gap-1.5 transition"
            >
              <ArrowDown className="w-4 h-4" />
              <span>Next</span>
            </button>
          </div>

          {/* Up Next Queue */}
          {upNextVideos.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-white/10">
              <p className="text-xs font-semibold text-zinc-400">Up Next</p>
              <div className="space-y-2">
                {upNextVideos.map((item, offsetIdx) => {
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
                        {item.poster_url ? (
                          <img
                            src={item.poster_url}
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
                          {formatCompactCount(item.likes)} likes
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
            <span className="font-mono text-zinc-400">↑ ↓ · Space · M</span>
          </div>
          <button
            type="button"
            onClick={onOpenStudio}
            className="w-full min-h-[44px] px-4 text-xs font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 flex items-center justify-center gap-1.5 transition"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Open ReelCraft Studio</span>
          </button>
        </div>
      </aside>
    </div>
  );
}
