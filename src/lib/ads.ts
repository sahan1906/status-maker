export type AdSlotId =
  | 'adsgram'
  | 'monetag'
  | 'richads'
  | 'cleanads_rewarded'
  | 'cleanads_interstitial';

export interface PublicAppConfig {
  site_name: string;
  watermark_text: string;
  watermark_enabled: boolean;
  adsgram_enabled: boolean;
  adsgram_block_id: string;
  monetag_enabled: boolean;
  monetag_zone_id: string;
  richads_enabled: boolean;
  richads_pub_id: string;
  richads_app_id: string;
  cleanads_enabled: boolean;
  cleanads_placement_id: string;
  cleanads_interstitial_enabled: boolean;
  cleanads_interstitial_placement_id: string;
  cleanads_test_mode: boolean;
}

export const DEFAULT_APP_CONFIG: PublicAppConfig = {
  site_name: 'ReelCraft',
  watermark_text: 'ReelCraft',
  watermark_enabled: true,
  adsgram_enabled: false,
  adsgram_block_id: '',
  monetag_enabled: false,
  monetag_zone_id: '',
  richads_enabled: false,
  richads_pub_id: '',
  richads_app_id: '',
  cleanads_enabled: false,
  cleanads_placement_id: '',
  cleanads_interstitial_enabled: false,
  cleanads_interstitial_placement_id: '',
  cleanads_test_mode: false,
};

export interface AdSlotInfo {
  id: AdSlotId;
  label: string;
  shortLabel: string;
}

export interface RunRotatedAdResult {
  status: 'completed' | 'closed_early' | 'fallback_unlocked' | 'skipped';
  network?: string;
}

interface RichAdsControllerInstance {
  initialize: (cfg: { pubId: string; appId: string }) => void | Promise<void>;
  triggerInterstitialVideo?: () => Promise<unknown>;
  triggerInterstitialBanner?: () => Promise<unknown>;
}

type RichAdsControllerGlobal =
  | (new () => RichAdsControllerInstance)
  | RichAdsControllerInstance;

interface CleanAdsShowResult {
  completed?: boolean;
  rewarded?: boolean;
  reason?: string;
  error?: string;
}

declare global {
  interface Window {
    Adsgram?: {
      init: (cfg: { blockId: string }) => {
        show: () => Promise<{ done?: boolean; error?: boolean; state?: string; description?: string }>;
      };
    };
    TelegramAdsController?: RichAdsControllerGlobal;
    CleanAds?: {
      init: (cfg: { placementId: string; userId?: string; test?: boolean }) => {
        show: () => Promise<CleanAdsShowResult | void>;
      };
    };
    [key: string]: unknown;
  }
}

const ROTATION_STORAGE_KEY = 'reelcraft_ad_rotation_idx';
const MONETAG_SDK_URL = 'https://libtl.com/sdk.js';
const ADSGRAM_SDK_URL = 'https://sad.adsgram.ai/js/sad.min.js';
const RICHADS_SDK_URL = 'https://richinfo.co/richpartners/telegram/js/tg-ob.js';
const CLEANADS_SDK_URL = 'https://api.cleanads.ai/sdk/v1.js';

let activeMonetagZones = new Set<string>();
let richAdsController: RichAdsControllerInstance | null = null;
let richAdsInitKey = '';

// ---------------------------------------------------------------------------
// Smart snippet extractors (safe for both Admin inputs and runtime safety)
// ---------------------------------------------------------------------------

export function extractAdsGramBlockId(raw: string): string {
  const input = (raw || '').trim();
  if (!input) return '';
  const match = input.match(/blockId\s*[:=]\s*['"`]([^'"`]+)['"`]/i);
  if (match?.[1]) return match[1].trim();
  return input;
}

export function extractMonetagZoneId(raw: string): string {
  const input = (raw || '').trim();
  if (!input) return '';
  // Match data-zone="1234567" or data-sdk="show_1234567" or show_1234567()
  const zoneAttr = input.match(/data-zone\s*=\s*['"`]?(\d+)['"`]?/i);
  if (zoneAttr?.[1]) return zoneAttr[1];
  const sdkAttr = input.match(/show_(\d+)/i);
  if (sdkAttr?.[1]) return sdkAttr[1];
  const digitsOnly = input.match(/\b(\d{4,12})\b/);
  if (digitsOnly?.[1]) return digitsOnly[1];
  return input.replace(/[^\d]/g, '');
}

export function extractRichAdsIds(raw: string): { pubId?: string; appId?: string } {
  const input = (raw || '').trim();
  if (!input) return {};
  const pubMatch = input.match(/pubId\s*[:=]\s*['"`]?([A-Za-z0-9_-]+)['"`]?/i);
  const appMatch = input.match(/appId\s*[:=]\s*['"`]?([A-Za-z0-9_-]+)['"`]?/i);
  return {
    ...(pubMatch?.[1] ? { pubId: pubMatch[1].trim() } : {}),
    ...(appMatch?.[1] ? { appId: appMatch[1].trim() } : {}),
  };
}

export function extractCleanAdsPlacementId(raw: string): string {
  const input = (raw || '').trim();
  if (!input) return '';
  const fieldMatch = input.match(/placementId\s*[:=]\s*['"`]([^'"`]+)['"`]/i);
  if (fieldMatch?.[1]) return fieldMatch[1].trim();
  const plMatch = input.match(/\b(pl_[A-Za-z0-9_-]+)\b/);
  if (plMatch?.[1]) return plMatch[1].trim();
  return input;
}

// ---------------------------------------------------------------------------
// Active rotation queue helpers
// ---------------------------------------------------------------------------

export function getEnabledAdQueue(config: PublicAppConfig): AdSlotInfo[] {
  const queue: AdSlotInfo[] = [];

  if (config.adsgram_enabled && extractAdsGramBlockId(config.adsgram_block_id)) {
    queue.push({ id: 'adsgram', label: 'AdsGram', shortLabel: 'AdsGram' });
  }
  if (config.monetag_enabled && extractMonetagZoneId(config.monetag_zone_id)) {
    queue.push({ id: 'monetag', label: 'Monetag', shortLabel: 'Monetag' });
  }
  if (config.richads_enabled && config.richads_pub_id.trim() && config.richads_app_id.trim()) {
    queue.push({ id: 'richads', label: 'RichAds', shortLabel: 'RichAds' });
  }
  if (config.cleanads_enabled && extractCleanAdsPlacementId(config.cleanads_placement_id)) {
    queue.push({
      id: 'cleanads_rewarded',
      label: 'CleanAds Rewarded',
      shortLabel: 'CleanAds',
    });
  }
  if (
    config.cleanads_interstitial_enabled &&
    extractCleanAdsPlacementId(config.cleanads_interstitial_placement_id)
  ) {
    queue.push({
      id: 'cleanads_interstitial',
      label: 'CleanAds Interstitial',
      shortLabel: 'CleanAds Interstitial',
    });
  }

  return queue;
}

export function hasEnabledAdNetworks(config: PublicAppConfig): boolean {
  return getEnabledAdQueue(config).length > 0;
}

function readRotationIndex(): number {
  try {
    const raw = window.localStorage.getItem(ROTATION_STORAGE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeRotationIndex(idx: number): void {
  try {
    window.localStorage.setItem(ROTATION_STORAGE_KEY, String(idx));
  } catch {
    // Ignore storage errors in private webviews
  }
}

export function getNextAdSlot(config: PublicAppConfig): AdSlotInfo | null {
  const queue = getEnabledAdQueue(config);
  if (queue.length === 0) return null;
  const idx = readRotationIndex() % queue.length;
  return queue[idx];
}

// ---------------------------------------------------------------------------
// Script loading & Monetag cleanup
// ---------------------------------------------------------------------------

function loadScriptOnce(
  src: string,
  attrs?: Record<string, string>,
  selectorOverride?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const selector = selectorOverride || `script[src="${src}"]`;
    const existing = document.querySelector<HTMLScriptElement>(selector);
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
        once: true,
      });
      // Resolve shortly if script was already loaded before dataset flag existed
      setTimeout(() => resolve(), 350);
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        script.setAttribute(k, v);
      }
    }
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Cleans up Monetag <script> tag(s) and window["show_<zoneId>"] globals when Monetag
 * is disabled or its zone changes in Admin during the same session.
 */
export function cleanupMonetag(zoneId?: string): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const scripts = document.querySelectorAll('script[src*="libtl.com/sdk.js"]');
  scripts.forEach((el) => {
    const z = el.getAttribute('data-zone');
    if (z) activeMonetagZones.add(z);
    el.remove();
  });

  if (zoneId) {
    const clean = extractMonetagZoneId(zoneId);
    if (clean) activeMonetagZones.add(clean);
  }

  activeMonetagZones.forEach((z) => {
    const fnKey = `show_${z}`;
    try {
      delete window[fnKey];
    } catch {
      window[fnKey] = undefined;
    }
  });
  activeMonetagZones = new Set<string>();
}

/**
 * Safely preloads enabled SDK scripts without triggering auto-ads.
 * Note: For RichAds, we preload tg-ob.js ONLY and defer TelegramAdsController.initialize()
 * until the user actually taps Watch Ad on the Download Unlock step.
 */
export function preloadEnabledAdScripts(config: PublicAppConfig): void {
  if (typeof document === 'undefined') return;

  if (config.adsgram_enabled && extractAdsGramBlockId(config.adsgram_block_id)) {
    loadScriptOnce(ADSGRAM_SDK_URL).catch(() => {});
  }

  const monetagZone = extractMonetagZoneId(config.monetag_zone_id);
  if (config.monetag_enabled && monetagZone) {
    const fnName = `show_${monetagZone}`;
    const existingZone = document
      .querySelector('script[src*="libtl.com/sdk.js"]')
      ?.getAttribute('data-zone');
    if (existingZone && existingZone !== monetagZone) {
      cleanupMonetag(existingZone);
    }
    activeMonetagZones.add(monetagZone);
    loadScriptOnce(
      MONETAG_SDK_URL,
      { 'data-zone': monetagZone, 'data-sdk': fnName },
      `script[src="${MONETAG_SDK_URL}"][data-zone="${monetagZone}"]`
    ).catch(() => {});
  } else {
    cleanupMonetag(monetagZone);
  }

  // RichAds: preload script ONLY — never initialize here so auto-timers never fire early
  if (config.richads_enabled && config.richads_pub_id.trim() && config.richads_app_id.trim()) {
    loadScriptOnce(RICHADS_SDK_URL).catch(() => {});
  }

  const hasCleanAds =
    (config.cleanads_enabled && extractCleanAdsPlacementId(config.cleanads_placement_id)) ||
    (config.cleanads_interstitial_enabled &&
      extractCleanAdsPlacementId(config.cleanads_interstitial_placement_id));
  if (hasCleanAds) {
    loadScriptOnce(CLEANADS_SDK_URL).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Per-network runners
// ---------------------------------------------------------------------------

type SingleAttemptOutcome = 'completed' | 'closed_early' | 'no_fill';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    promise
      .then((val) => {
        window.clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        window.clearTimeout(timer);
        reject(err);
      });
  });
}

async function runAdsGram(blockId: string): Promise<SingleAttemptOutcome> {
  try {
    if (!window.Adsgram?.init) {
      await withTimeout(loadScriptOnce(ADSGRAM_SDK_URL), 6000, 'AdsGram SDK');
    }
    if (!window.Adsgram?.init) return 'no_fill';
    const controller = window.Adsgram.init({ blockId });
    const res = await controller.show();
    if (res?.done && !res.error) return 'completed';
    // User closed ad before finishing (not a technical error / no-fill)
    if (res && !res.done && !res.error) return 'closed_early';
    return 'no_fill';
  } catch (err) {
    // AdsGram rejects with { done: false, error: false, state: 'destroy' } on early close in some builds
    if (
      err &&
      typeof err === 'object' &&
      'done' in err &&
      (err as { done?: boolean; error?: boolean }).done === false &&
      (err as { error?: boolean }).error === false
    ) {
      return 'closed_early';
    }
    return 'no_fill';
  }
}

async function runMonetag(zoneId: string): Promise<SingleAttemptOutcome> {
  try {
    const fnName = `show_${zoneId}`;
    const existingZone = document
      .querySelector('script[src*="libtl.com/sdk.js"]')
      ?.getAttribute('data-zone');
    if (existingZone && existingZone !== zoneId) {
      cleanupMonetag(existingZone);
    }

    if (typeof window[fnName] !== 'function') {
      activeMonetagZones.add(zoneId);
      await withTimeout(
        loadScriptOnce(
          MONETAG_SDK_URL,
          { 'data-zone': zoneId, 'data-sdk': fnName },
          `script[src="${MONETAG_SDK_URL}"][data-zone="${zoneId}"]`
        ),
        6000,
        'Monetag SDK'
      );
      // Give SDK a brief tick to attach window["show_<zoneId>"]
      for (let i = 0; i < 6 && typeof window[fnName] !== 'function'; i += 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    const fn = window[fnName];
    if (typeof fn !== 'function') return 'no_fill';
    await (fn as () => Promise<unknown>)();
    return 'completed';
  } catch {
    return 'no_fill';
  }
}

async function runRichAds(pubId: string, appId: string): Promise<SingleAttemptOutcome> {
  try {
    if (!window.TelegramAdsController) {
      await withTimeout(loadScriptOnce(RICHADS_SDK_URL), 6000, 'RichAds SDK');
    }
    const Ctrl = window.TelegramAdsController;
    if (!Ctrl) return 'no_fill';

    const initKey = `${pubId}::${appId}`;
    if (!richAdsController || richAdsInitKey !== initKey) {
      richAdsController = typeof Ctrl === 'function' ? new Ctrl() : Ctrl;
      await richAdsController.initialize({ pubId, appId });
      richAdsInitKey = initKey;
    }

    // Try interstitial video first; fall back to interstitial banner on unavailable/no-fill
    if (typeof richAdsController.triggerInterstitialVideo === 'function') {
      try {
        await richAdsController.triggerInterstitialVideo();
        return 'completed';
      } catch {
        // Fall through to banner below
      }
    }

    if (typeof richAdsController.triggerInterstitialBanner === 'function') {
      await richAdsController.triggerInterstitialBanner();
      return 'completed';
    }

    return 'no_fill';
  } catch {
    return 'no_fill';
  }
}

async function runCleanAds(
  placementId: string,
  telegramUserId: string,
  testMode: boolean
): Promise<SingleAttemptOutcome> {
  try {
    if (!window.CleanAds?.init) {
      await withTimeout(loadScriptOnce(CLEANADS_SDK_URL), 6000, 'CleanAds SDK');
    }
    if (!window.CleanAds?.init) return 'no_fill';

    const instance = window.CleanAds.init({
      placementId,
      userId: telegramUserId || 'guest',
      test: testMode,
    });
    const res = await instance.show();
    if (res && typeof res === 'object' && res.reason === 'closed_early') {
      return 'closed_early';
    }
    return 'completed';
  } catch (err) {
    if (err && typeof err === 'object' && (err as { reason?: string }).reason === 'closed_early') {
      return 'closed_early';
    }
    return 'no_fill';
  }
}

async function executeSingleSlot(
  slot: AdSlotId,
  config: PublicAppConfig,
  telegramUserId: string
): Promise<SingleAttemptOutcome> {
  switch (slot) {
    case 'adsgram':
      return runAdsGram(extractAdsGramBlockId(config.adsgram_block_id));
    case 'monetag':
      return runMonetag(extractMonetagZoneId(config.monetag_zone_id));
    case 'richads':
      return runRichAds(config.richads_pub_id.trim(), config.richads_app_id.trim());
    case 'cleanads_rewarded':
      return runCleanAds(
        extractCleanAdsPlacementId(config.cleanads_placement_id),
        telegramUserId,
        config.cleanads_test_mode
      );
    case 'cleanads_interstitial':
      return runCleanAds(
        extractCleanAdsPlacementId(config.cleanads_interstitial_placement_id),
        telegramUserId,
        config.cleanads_test_mode
      );
  }
}

// ---------------------------------------------------------------------------
// Ordered Rotation + No-Fill Fallback Controller (strictly 1 ad per unlock)
// ---------------------------------------------------------------------------

export async function runRotatedAd(
  config: PublicAppConfig,
  options?: {
    telegramUserId?: string;
    onTryingNetwork?: (networkLabel: string) => void;
    onFallbackCountdown?: (secondsLeft: number) => void;
    fallbackSeconds?: number;
  }
): Promise<RunRotatedAdResult> {
  const queue = getEnabledAdQueue(config);
  if (queue.length === 0) {
    return { status: 'skipped' };
  }

  const currentIdx = readRotationIndex();
  const startIdx = currentIdx % queue.length;
  const ordered = [...queue.slice(startIdx), ...queue.slice(0, startIdx)];
  const tgUid = options?.telegramUserId || '';

  for (const slot of ordered) {
    options?.onTryingNetwork?.(slot.label);
    const outcome = await executeSingleSlot(slot.id, config, tgUid);

    if (outcome === 'completed') {
      writeRotationIndex(currentIdx + 1);
      return { status: 'completed', network: slot.label };
    }

    if (outcome === 'closed_early') {
      // Do NOT stack another ad immediately when user closed the ad early
      return { status: 'closed_early', network: slot.label };
    }
    // outcome === 'no_fill' -> automatically try next enabled network in queue
  }

  // All enabled networks failed / no-fill (e.g., desktop browser preview):
  // Gracefully unlock after a brief countdown so downloads never break.
  writeRotationIndex(currentIdx + 1);
  const totalSec = options?.fallbackSeconds ?? 3;
  for (let sec = totalSec; sec >= 1; sec -= 1) {
    options?.onFallbackCountdown?.(sec);
    await new Promise((r) => setTimeout(r, 1000));
  }
  options?.onFallbackCountdown?.(0);
  return { status: 'fallback_unlocked' };
}

// ---------------------------------------------------------------------------
// Public settings fetcher (uses /api/settings with fallback to /api/config)
// ---------------------------------------------------------------------------

export async function fetchPublicAppConfig(): Promise<PublicAppConfig> {
  const endpoints = ['/api/settings', '/api/config'];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = (await res.json()) as Partial<PublicAppConfig> & {
        reward_ad_enabled?: boolean;
      };
      const adsgramBlockId = typeof data.adsgram_block_id === 'string' ? data.adsgram_block_id : '';
      const adsgramEnabled =
        typeof data.adsgram_enabled === 'boolean'
          ? data.adsgram_enabled
          : Boolean(adsgramBlockId.trim());

      return {
        ...DEFAULT_APP_CONFIG,
        ...data,
        adsgram_block_id: adsgramBlockId,
        adsgram_enabled: adsgramEnabled,
      };
    } catch {
      // Try next endpoint
    }
  }
  return DEFAULT_APP_CONFIG;
}
