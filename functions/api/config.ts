import { getAllSettingsMap, jsonResponse } from '../_lib/security';
import { PagesHandler, PUBLIC_SETTING_KEYS } from '../_lib/types';

function parseShortsEveryN(raw?: string): number {
  const n = Number.parseInt(raw || '1', 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, n));
}

export const onRequestGet: PagesHandler = async ({ env }) => {
  try {
    const map = await getAllSettingsMap(env.DB);
    const publicConfig: Record<string, string | boolean | number> = {
      site_name: map.site_name || 'ReelCraft',
      watermark_text: map.watermark_text || 'ReelCraft',
      watermark_enabled: (map.watermark_enabled ?? 'true') === 'true',
      reward_ad_enabled: (map.reward_ad_enabled ?? 'false') === 'true',
      ad_provider: map.ad_provider || 'adsgram',
      adsgram_block_id: map.adsgram_block_id || '',
      monetag_zone_id: map.monetag_zone_id || '',
      richads_pub_id: map.richads_pub_id || '',
      gigapub_id: map.gigapub_id || '',
      cleanads_rewarded_enabled: (map.cleanads_rewarded_enabled ?? 'false') === 'true',
      cleanads_rewarded_placement_id: map.cleanads_rewarded_placement_id || '',
      cleanads_interstitial_enabled: (map.cleanads_interstitial_enabled ?? 'false') === 'true',
      cleanads_interstitial_placement_id: map.cleanads_interstitial_placement_id || '',
      cleanads_test_mode: (map.cleanads_test_mode ?? 'false') === 'true',
      shorts_ad_enabled: (map.shorts_ad_enabled ?? 'true') === 'true',
      shorts_ad_every_n: parseShortsEveryN(map.shorts_ad_every_n),
      shorts_download_ad_enabled: (map.shorts_download_ad_enabled ?? 'true') === 'true',
      telegram_bot_username: (map.telegram_bot_username || '').replace(/^@+/, '').trim(),
      telegram_miniapp_short_name: (map.telegram_miniapp_short_name || '').trim(),
    };

    // Ensure only allowlisted public keys are exposed
    const safeOut: Record<string, string | boolean | number> = {};
    for (const key of PUBLIC_SETTING_KEYS) {
      safeOut[key] = publicConfig[key];
    }

    return jsonResponse(safeOut);
  } catch {
    return jsonResponse({
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
      shorts_ad_enabled: true,
      shorts_ad_every_n: 5,
      shorts_download_ad_enabled: true,
      telegram_bot_username: '',
      telegram_miniapp_short_name: '',
    });
  }
};
