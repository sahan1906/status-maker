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
};

declare global {
  interface Window {
    Adsgram?: {
      init: (cfg: { blockId: string }) => {
        show: () => Promise<{ done: boolean; error: boolean; description?: string }>;
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

export function shouldTriggerRewardAd(config: PublicAppConfig): boolean {
  if (!config.reward_ad_enabled) return false;
  return Boolean(getActiveProviderId(config));
}

function loadExternalScript(src: string, attrs?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
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
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Triggers the configured Rewarded Ad network SDK (AdsGram, Monetag, RichAds, or GigaPub).
 * Automatically returns 'skipped' if ads are disabled or unconfigured in Admin.
 */
export async function runRewardedAd(
  config: PublicAppConfig
): Promise<'completed' | 'skipped' | 'cancelled'> {
  if (!shouldTriggerRewardAd(config)) {
    return 'skipped';
  }

  const providerId = getActiveProviderId(config);

  try {
    if (config.ad_provider === 'adsgram') {
      if (!window.Adsgram?.init) {
        await loadExternalScript('https://sad.adsgram.ai/js/sad.min.js');
      }
      if (!window.Adsgram?.init) return 'skipped';
      const controller = window.Adsgram.init({ blockId: providerId });
      const res = await controller.show();
      return res?.done && !res.error ? 'completed' : 'cancelled';
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
      if (typeof fn !== 'function') return 'skipped';
      await (fn as () => Promise<void>)();
      return 'completed';
    }

    if (config.ad_provider === 'gigapub') {
      if (typeof window.showGiga !== 'function') {
        await loadExternalScript(`https://ad.gigapub.tech/script?id=${encodeURIComponent(providerId)}`);
      }
      if (typeof window.showGiga !== 'function') return 'skipped';
      await window.showGiga();
      return 'completed';
    }

    if (config.ad_provider === 'richads') {
      if (!window.TelegramAdsController) {
        await loadExternalScript('https://richinfo.co/richpartners/telegram/js/tg-ob.js');
      }
      if (!window.TelegramAdsController) return 'skipped';
      window.TelegramAdsController.initialize({ pubId: providerId });
      if (window.TelegramAdsController.triggerNativeNotification) {
        await window.TelegramAdsController.triggerNativeNotification();
      }
      return 'completed';
    }

    return 'skipped';
  } catch {
    return 'cancelled';
  }
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
