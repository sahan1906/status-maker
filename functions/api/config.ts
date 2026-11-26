import { getAllSettingsMap, jsonResponse } from '../_lib/security';
import { PagesHandler, PUBLIC_SETTING_KEYS } from '../_lib/types';

export const onRequestGet: PagesHandler = async ({ env }) => {
  try {
    const map = await getAllSettingsMap(env.DB);
    const publicConfig: Record<string, string | boolean> = {
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
    };

    // Ensure only allowlisted public keys are exposed
    const safeOut: Record<string, string | boolean> = {};
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
    });
  }
};
