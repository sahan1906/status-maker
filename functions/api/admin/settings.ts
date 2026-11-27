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
  'shorts_ad_enabled',
  'shorts_download_ad_enabled',
]);

function clampShortsEveryN(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? '1'), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, n));
}

function sanitizeChannelId(raw: unknown): string {
  return String(raw || '')
    .trim()
    .replace(/[^0-9-]/g, '')
    .slice(0, 32);
}

function sanitizeTelegramSlug(raw: unknown): string {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 64);
}

async function resolveBotUsernameFromToken(token: string): Promise<string> {
  if (!token) return '';
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!res.ok) return '';
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { username?: string };
    };
    return data.ok && data.result?.username ? sanitizeTelegramSlug(data.result.username) : '';
  } catch {
    return '';
  }
}

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

  let botUsername = sanitizeTelegramSlug(map.telegram_bot_username || '');
  if (!botUsername && effectiveToken) {
    botUsername = await resolveBotUsernameFromToken(effectiveToken);
    if (botUsername) {
      await setSetting(env.DB, 'telegram_bot_username', botUsername);
    }
  }

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
    shorts_ad_enabled: (map.shorts_ad_enabled ?? 'true') === 'true',
    shorts_ad_every_n: clampShortsEveryN(map.shorts_ad_every_n),
    shorts_download_ad_enabled: (map.shorts_download_ad_enabled ?? 'true') === 'true',
    shorts_channel_id: sanitizeChannelId(map.shorts_channel_id || ''),
    telegram_bot_username: botUsername,
    telegram_miniapp_short_name: sanitizeTelegramSlug(map.telegram_miniapp_short_name || ''),
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
        const cleanToken = raw.trim().slice(0, 120);
        await setSetting(env.DB, 'bot_token', cleanToken);
        const detected = await resolveBotUsernameFromToken(cleanToken);
        if (detected) {
          await setSetting(env.DB, 'telegram_bot_username', detected);
        }
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

    if (key === 'shorts_ad_every_n') {
      await setSetting(env.DB, key, String(clampShortsEveryN(raw)));
      continue;
    }

    if (key === 'shorts_channel_id') {
      await setSetting(env.DB, key, sanitizeChannelId(raw));
      continue;
    }

    if (key === 'telegram_bot_username' || key === 'telegram_miniapp_short_name') {
      await setSetting(env.DB, key, sanitizeTelegramSlug(raw));
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
