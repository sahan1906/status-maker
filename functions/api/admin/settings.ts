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

    if (key === 'watermark_enabled' || key === 'reward_ad_enabled') {
      await setSetting(env.DB, key, raw === true || raw === 'true' ? 'true' : 'false');
      continue;
    }

    if (key === 'ad_provider') {
      const provider = typeof raw === 'string' && ALLOWED_PROVIDERS.has(raw) ? raw : 'adsgram';
      await setSetting(env.DB, key, provider);
      continue;
    }

    if (typeof raw === 'string') {
      await setSetting(env.DB, key, raw.trim().slice(0, 120));
    }
  }

  return jsonResponse({ ok: true });
};
