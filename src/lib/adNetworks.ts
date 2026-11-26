export type AdProvider = 'adsgram' | 'monetag' | 'richads' | 'gigapub';

export interface PublicAppConfig {
  site_name: string;
  watermark_text: string;
  watermark_enabled: boolean;
  reward_ad_enabled: boolean;
  ad_provider: AdProvider;
  adsgram_block_id: string;
  monetag_zone_id: string;
  richads_pub_id: string;
  gigapub_id: string;
  cleanads_rewarded_enabled: boolean;
  cleanads_rewarded_placement_id: string;
  cleanads_interstitial_enabled: boolean;
  cleanads_interstitial_placement_id: string;
  cleanads_test_mode: boolean;
}

export const DEFAULT_APP_CONFIG: PublicAppConfig = {
  site_name: 'ReelCraft',
  watermark_text: 'ReelCraft',
  watermark_enabled: true,
  reward_ad_enabled: false,
  ad_provider: 'adsgram',
  adsgram_block_id: '',
  monetag_zone_id: '',
  richads_pub_id: '',
  gigapub_id: '',
  cleanads_rewarded_enabled: false,
  cleanads_rewarded_placement_id: '',
  cleanads_interstitial_enabled: false,
  cleanads_interstitial_placement_id: '',
  cleanads_test_mode: false,
};

interface CleanAdsResult {
  completed?: boolean;
  rewarded?: boolean;
  reason?: string;
  code?: string;
  error?: string | boolean;
  message?: string;
}

declare global {
  interface Window {
    Adsgram?: {
      init: (cfg: { blockId: string }) => {
        show: () => Promise<{ done: boolean; error: boolean; description?: string }>;
      };
    };
    CleanAds?: {
      init: (cfg: { placementId: string; userId: string; test?: boolean }) => {
        show: () => Promise<CleanAdsResult | void>;
      };
    };
    showGiga?: () => Promise<void>;
    TelegramAdsController?: {
      initialize: (cfg: { pubId: string; appId?: string }) => void;
      triggerNativeNotification?: () => Promise<void>;
    };
    [key: string]: unknown;
  }
}

const CLEANADS_SDK_URL = 'https://api.cleanads.ai/sdk/v1.js';
const INTERSTITIAL_COOLDOWN_MS = 90_000; // 90 seconds between non-rewarded/back-to-back ads
const ANON_USER_KEY = 'reelcraft_anon_uid';

const scriptLoadPromises = new Map<string, Promise<void>>();
let fallbackMemoryUserId: string | null = null;
let lastAdShownAt = 0;

/**
 * Extracts a CleanAds placement ID (pl_...) even if the admin pastes a full JS snippet.
 */
export function extractCleanAdsPlacementId(raw: string): string {
  const input = (raw || '').trim();
  if (!input) return '';
  const plMatch = input.match(/\b(pl_[a-zA-Z0-9_-]+)\b/);
  if (plMatch?.[1]) return plMatch[1];
  const propMatch = input.match(/placementId\s*[:=]\s*['"`]([^'"`\s]+)['"`]/i);
  if (propMatch?.[1]) return propMatch[1].trim();
  return input;
}

function getCleanAdsUserId(): string {
  const tgId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  if (tgId) return String(tgId);

  try {
    const existing = window.localStorage.getItem(ANON_USER_KEY);
    if (existing) return existing;
    const created = `guest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(ANON_USER_KEY, created);
    return created;
  } catch {
    if (!fallbackMemoryUserId) {
      fallbackMemoryUserId = `guest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    return fallbackMemoryUserId;
  }
}

export function getActiveProviderId(config: PublicAppConfig): string {
  switch (config.ad_provider) {
    case 'adsgram':
      return config.adsgram_block_id.trim();
    case 'monetag':
      return config.monetag_zone_id.trim();
    case 'richads':
      return config.richads_pub_id.trim();
    case 'gigapub':
      return config.gigapub_id.trim();
    default:
      return '';
  }
}

export function isCleanAdsRewardedActive(config: PublicAppConfig): boolean {
  return (
    Boolean(config.cleanads_rewarded_enabled) &&
    Boolean(extractCleanAdsPlacementId(config.cleanads_rewarded_placement_id))
  );
}

export function isCleanAdsInterstitialActive(config: PublicAppConfig): boolean {
  return (
    Boolean(config.cleanads_interstitial_enabled) &&
    Boolean(extractCleanAdsPlacementId(config.cleanads_interstitial_placement_id))
  );
}

export function isLegacyRewardedActive(config: PublicAppConfig): boolean {
  return Boolean(config.reward_ad_enabled) && Boolean(getActiveProviderId(config));
}

export function shouldTriggerRewardAd(config: PublicAppConfig): boolean {
  return isCleanAdsRewardedActive(config) || isLegacyRewardedActive(config);
}

export function getActiveRewardAdLabel(config: PublicAppConfig): string {
  if (isCleanAdsRewardedActive(config)) return 'CleanAds';
  const labels: Record<AdProvider, string> = {
    adsgram: 'AdsGram',
    monetag: 'Monetag',
    richads: 'RichAds',
    gigapub: 'GigaPub',
  };
  return labels[config.ad_provider] || 'Sponsored';
}

function loadExternalScript(src: string, attrs?: Record<string, string>): Promise<void> {
  const existingPromise = scriptLoadPromises.get(src);
  if (existingPromise) return existingPromise;

  const existingTag = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
  if (existingTag && existingTag.dataset.loaded === 'true') {
    return Promise.resolve();
  }

  const promise = new Promise<void>((resolve, reject) => {
    const script = existingTag || document.createElement('script');
    if (!existingTag) {
      script.src = src;
      script.async = true;
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          script.setAttribute(k, v);
        }
      }
      document.head.appendChild(script);
    }

    const onLoad = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    const onError = () => {
      scriptLoadPromises.delete(src);
      reject(new Error(`Failed to load ${src}`));
    };

    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
  });

  scriptLoadPromises.set(src, promise);
  return promise;
}

/**
 * Preloads the official CleanAds SDK once on startup when either CleanAds unit is enabled.
 */
export function preloadCleanAdsSdk(config: PublicAppConfig): void {
  if (typeof document === 'undefined') return;
  if (!isCleanAdsRewardedActive(config) && !isCleanAdsInterstitialActive(config)) return;
  if (window.CleanAds?.init) return;
  loadExternalScript(CLEANADS_SDK_URL).catch(() => {
    // Non-fatal; will retry gracefully on ad trigger or fall back
  });
}

function isUserClosedReason(value: unknown): boolean {
  if (!value) return false;
  const text = String(value).toLowerCase();
  return (
    text.includes('closed') ||
    text.includes('skipped') ||
    text.includes('skip') ||
    text.includes('cancel') ||
    text.includes('dismiss')
  );
}

type SingleAdOutcome = 'completed' | 'cancelled' | 'no_fill_or_error';

async function runCleanAdsUnit(
  rawPlacementId: string,
  testMode: boolean,
  isRewarded: boolean
): Promise<SingleAdOutcome> {
  const placementId = extractCleanAdsPlacementId(rawPlacementId);
  if (!placementId) return 'no_fill_or_error';

  try {
    if (!window.CleanAds?.init) {
      await loadExternalScript(CLEANADS_SDK_URL);
    }
    if (!window.CleanAds?.init) {
      return 'no_fill_or_error';
    }

    const ad = window.CleanAds.init({
      placementId,
      userId: getCleanAdsUserId(),
      test: Boolean(testMode),
    });

    const result = await ad.show();

    if (result && typeof result === 'object') {
      if (isRewarded) {
        if (isUserClosedReason(result.reason) || isUserClosedReason(result.code)) {
          return 'cancelled';
        }
        if (result.completed === false || result.rewarded === false) {
          if (
            String(result.reason || result.error || '').toLowerCase().includes('no_fill') ||
            String(result.reason || result.error || '').toLowerCase().includes('network')
          ) {
            return 'no_fill_or_error';
          }
          return 'cancelled';
        }
        if (result.error) {
          return 'no_fill_or_error';
        }
      }
    }

    return 'completed';
  } catch (err) {
    if (isRewarded && err && typeof err === 'object') {
      const rec = err as Record<string, unknown>;
      if (
        isUserClosedReason(rec.reason) ||
        isUserClosedReason(rec.code) ||
        isUserClosedReason(rec.message)
      ) {
        return 'cancelled';
      }
    } else if (isRewarded && typeof err === 'string' && isUserClosedReason(err)) {
      return 'cancelled';
    }
    return 'no_fill_or_error';
  }
}

async function runLegacyProvider(config: PublicAppConfig): Promise<SingleAdOutcome> {
  const providerId = getActiveProviderId(config);
  if (!providerId) return 'no_fill_or_error';

  try {
    if (config.ad_provider === 'adsgram') {
      if (!window.Adsgram?.init) {
        await loadExternalScript('https://sad.adsgram.ai/js/sad.min.js');
      }
      if (!window.Adsgram?.init) return 'no_fill_or_error';
      const controller = window.Adsgram.init({ blockId: providerId });
      const res = await controller.show();
      if (res?.done && !res.error) return 'completed';
      if (res?.error && String(res.description || '').toLowerCase().includes('no')) {
        return 'no_fill_or_error';
      }
      return 'cancelled';
    }

    if (config.ad_provider === 'monetag') {
      const fnName = `show_${providerId}`;
      if (typeof window[fnName] !== 'function') {
        await loadExternalScript('https://libtl.com/sdk.js', {
          'data-zone': providerId,
          'data-sdk': fnName,
        });
      }
      const fn = window[fnName];
      if (typeof fn !== 'function') return 'no_fill_or_error';
      await (fn as () => Promise<void>)();
      return 'completed';
    }

    if (config.ad_provider === 'gigapub') {
      if (typeof window.showGiga !== 'function') {
        await loadExternalScript(
          `https://ad.gigapub.tech/script?id=${encodeURIComponent(providerId)}`
        );
      }
      if (typeof window.showGiga !== 'function') return 'no_fill_or_error';
      await window.showGiga();
      return 'completed';
    }

    if (config.ad_provider === 'richads') {
      if (!window.TelegramAdsController) {
        await loadExternalScript('https://richinfo.co/richpartners/telegram/js/tg-ob.js');
      }
      if (!window.TelegramAdsController) return 'no_fill_or_error';
      window.TelegramAdsController.initialize({ pubId: providerId });
      if (window.TelegramAdsController.triggerNativeNotification) {
        await window.TelegramAdsController.triggerNativeNotification();
      }
      return 'completed';
    }

    return 'no_fill_or_error';
  } catch (err) {
    if (err && typeof err === 'object') {
      const rec = err as Record<string, unknown>;
      if (isUserClosedReason(rec.reason) || isUserClosedReason(rec.description)) {
        return 'cancelled';
      }
    }
    return 'no_fill_or_error';
  }
}

/**
 * Triggers Rewarded Ad(s): tries CleanAds Rewarded (if enabled) and falls back to the configured
 * secondary rewarded network (AdsGram / Monetag / RichAds / GigaPub) on no_fill or SDK error.
 * Never locks the user out of exporting if all networks have no_fill or network failure.
 * Only blocks unlock when the user explicitly skips/closes a rewarded ad early.
 */
export async function runRewardedAd(
  config: PublicAppConfig
): Promise<'completed' | 'skipped' | 'cancelled'> {
  const queue: Array<'cleanads' | 'legacy'> = [];
  if (isCleanAdsRewardedActive(config)) queue.push('cleanads');
  if (isLegacyRewardedActive(config)) queue.push('legacy');

  if (queue.length === 0) {
    return 'skipped';
  }

  for (const slot of queue) {
    const outcome =
      slot === 'cleanads'
        ? await runCleanAdsUnit(
            config.cleanads_rewarded_placement_id,
            config.cleanads_test_mode,
            true
          )
        : await runLegacyProvider(config);

    if (outcome === 'completed') {
      lastAdShownAt = Date.now();
      return 'completed';
    }

    if (outcome === 'cancelled') {
      return 'cancelled';
    }
    // On 'no_fill_or_error', continue loop to try the next enabled ad network
  }

  // All enabled networks had no_fill / network failure — let user proceed so export never stalls
  return 'skipped';
}

/**
 * Triggers CleanAds Interstitial cleanly with cooldown enforcement so users are never spammed
 * back-to-back (e.g., after finishing an export or starting a new template/project).
 */
export async function runInterstitialAd(config: PublicAppConfig): Promise<boolean> {
  if (!isCleanAdsInterstitialActive(config)) return false;

  const now = Date.now();
  if (now - lastAdShownAt < INTERSTITIAL_COOLDOWN_MS) {
    return false;
  }

  lastAdShownAt = now;
  const outcome = await runCleanAdsUnit(
    config.cleanads_interstitial_placement_id,
    config.cleanads_test_mode,
    false
  );
  return outcome === 'completed';
}

export async function fetchPublicAppConfig(): Promise<PublicAppConfig> {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return DEFAULT_APP_CONFIG;
    const data = (await res.json()) as Partial<PublicAppConfig>;
    return {
      ...DEFAULT_APP_CONFIG,
      ...data,
    };
  } catch {
    return DEFAULT_APP_CONFIG;
  }
}
