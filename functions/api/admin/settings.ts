import {
  getAllSettingsMap,
  getEffectiveBotToken,
  jsonResponse,
  maskSecret,
  setSetting,
  verifyAdminRequest,
} from '../../_lib/security';
import { EDITABLE_SETTING_KEYS, PagesHandler } from '../../_lib/types';

const ALLOWED_PROVIDERS = new Set(['adsgram', 'monetag', 'richads', 'gigapub']);
const BOOLEAN_SETTING_KEYS = new Set([
  'watermark_enabled',
  'reward_ad_enabled',
  'cleanads_rewarded_enabled',
  'cleanads_interstitial_enabled',
  'cleanads_test_mode',
]);

function extractCleanAdsPlacementId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const plMatch = trimmed.match(/\b(pl_[a-zA-Z0-9_-]+)\b/);
  if (plMatch?.[1]) return plMatch[1].slice(0, 120);
  const propMatch = trimmed.match(/placementId\s*[:=]\s*['"`]([^'"`\s]+)['"`]/i);
  if (propMatch?.[1]) return propMatch[1].trim().slice(0, 120);
  return trimmed.slice(0, 120);
}

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const map = await getAllSettingsMap(env.DB);
  const effectiveToken = await getEffectiveBotToken(env);

  return jsonResponse({
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
    bot_token_configured: Boolean(effectiveToken),
    bot_token_masked: maskSecret(effectiveToken),
  });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload.' }, 400);
  }

  for (const key of EDITABLE_SETTING_KEYS) {
    if (!(key in body)) continue;
    const raw = body[key];

    if (key === 'bot_token') {
      // Only overwrite bot_token if a non-empty string was explicitly supplied
      if (typeof raw === 'string' && raw.trim().length > 0) {
        await setSetting(env.DB, 'bot_token', raw.trim().slice(0, 120));
      }
      continue;
    }

    if (BOOLEAN_SETTING_KEYS.has(key)) {
      await setSetting(env.DB, key, raw === true || raw === 'true' ? 'true' : 'false');
      continue;
    }

    if (key === 'ad_provider') {
      const provider = typeof raw === 'string' && ALLOWED_PROVIDERS.has(raw) ? raw : 'adsgram';
      await setSetting(env.DB, key, provider);
      continue;
    }

    if (
      (key === 'cleanads_rewarded_placement_id' || key === 'cleanads_interstitial_placement_id') &&
      typeof raw === 'string'
    ) {
      await setSetting(env.DB, key, extractCleanAdsPlacementId(raw));
      continue;
    }

    if (typeof raw === 'string') {
      await setSetting(env.DB, key, raw.trim().slice(0, 120));
    }
  }

  return jsonResponse({ ok: true });
};
