import { jsonResponse, verifyAdminRequest } from '../../_lib/security';
import {
  buildTapLinkUrls,
  ensureTapLinksTables,
  extractDestinationHost,
  generateDeveloperApiKey,
  generateShortCode,
  getTapLinkBaseConfig,
  sha256Hex,
  TapLinkApiKeyRow,
  TapLinkRow,
} from '../../_lib/taplinks';
import { PagesHandler } from '../../_lib/types';

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureTapLinksTables(env.DB);
  const origin = new URL(request.url).origin;
  const baseCfg = await getTapLinkBaseConfig(env.DB);

  const [statsRow, keysRes, linksRes] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as total_links,
              COALESCE(SUM(clicks), 0) as total_clicks,
              COALESCE(SUM(unlocks), 0) as total_unlocks
       FROM taplinks`
    ).first<{ total_links: number; total_clicks: number; total_unlocks: number }>(),
    env.DB.prepare(
      `SELECT id, name, contact_note, key_prefix, status, daily_limit, links_created, last_used_at, created_at
       FROM taplink_api_keys
       ORDER BY created_at DESC
       LIMIT 100`
    ).all<Omit<TapLinkApiKeyRow, 'key_hash'>>(),
    env.DB.prepare(
      `SELECT id, code, destination_url, title, creator_type, creator_ref, creator_label, clicks, unlocks, created_at
       FROM taplinks
       ORDER BY created_at DESC
       LIMIT 60`
    ).all<TapLinkRow>(),
  ]);

  const apiKeys = (keysRes.results || []).map((k) => ({
    id: k.id,
    name: k.name,
    contact_note: k.contact_note || '',
    key_prefix: k.key_prefix,
    status: k.status === 'revoked' ? 'revoked' : 'active',
    daily_limit: Number(k.daily_limit) || 500,
    links_created: Number(k.links_created) || 0,
    last_used_at: k.last_used_at ? new Date(Number(k.last_used_at)).toISOString() : null,
    created_at: new Date(Number(k.created_at) || Date.now()).toISOString(),
  }));

  const recentLinks = (linksRes.results || []).map((row) => ({
    id: row.id,
    code: row.code,
    title: row.title || extractDestinationHost(row.destination_url),
    destination_url: row.destination_url,
    destination_host: extractDestinationHost(row.destination_url),
    creator_type: row.creator_type,
    creator_label: row.creator_label || 'Mini App',
    clicks: Number(row.clicks) || 0,
    unlocks: Number(row.unlocks) || 0,
    created_at: new Date(Number(row.created_at) || Date.now()).toISOString(),
    ...buildTapLinkUrls(row.code, origin, baseCfg.botUsername, baseCfg.miniAppShortName),
  }));

  return jsonResponse({
    ok: true,
    stats: {
      totalLinks: Number(statsRow?.total_links) || 0,
      totalClicks: Number(statsRow?.total_clicks) || 0,
      totalUnlocks: Number(statsRow?.total_unlocks) || 0,
      activeKeys: apiKeys.filter((k) => k.status === 'active').length,
    },
    apiKeys,
    recentLinks,
  });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureTapLinksTables(env.DB);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'Invalid JSON request body.' }, 400);
  }

  const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  if (!name) {
    return jsonResponse({ error: 'Enter the verified developer or partner name.' }, 400);
  }

  const contactNote =
    typeof body.contact_note === 'string'
      ? body.contact_note.replace(/\s+/g, ' ').trim().slice(0, 140)
      : '';
  const parsedLimit = Number.parseInt(String(body.daily_limit ?? '500'), 10);
  const dailyLimit = Number.isFinite(parsedLimit)
    ? Math.max(10, Math.min(50000, parsedLimit))
    : 500;

  const { plainKey, keyPrefix } = generateDeveloperApiKey();
  const keyHash = await sha256Hex(plainKey);
  const id = `key_${Date.now().toString(36)}_${generateShortCode(6)}`;
  const createdAt = Date.now();

  await env.DB.prepare(
    `INSERT INTO taplink_api_keys (id, name, contact_note, key_prefix, key_hash, status, daily_limit, links_created, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 0, NULL, ?)`
  )
    .bind(id, name, contactNote, keyPrefix, keyHash, dailyLimit, createdAt)
    .run();

  return jsonResponse(
    {
      ok: true,
      plain_key: plainKey, // Shown ONCE to admin so they can send it privately to the verified partner
      apiKey: {
        id,
        name,
        contact_note: contactNote,
        key_prefix: keyPrefix,
        status: 'active',
        daily_limit: dailyLimit,
        links_created: 0,
        last_used_at: null,
        created_at: new Date(createdAt).toISOString(),
      },
    },
    201
  );
};

export const onRequestPatch: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureTapLinksTables(env.DB);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'Invalid JSON request body.' }, 400);
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const status = body.status === 'revoked' ? 'revoked' : body.status === 'active' ? 'active' : '';
  if (!id || !status) {
    return jsonResponse({ error: 'Provide key id and valid status (active or revoked).' }, 400);
  }

  await env.DB.prepare('UPDATE taplink_api_keys SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();

  return jsonResponse({ ok: true, id, status });
};

export const onRequestDelete: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureTapLinksTables(env.DB);
  const url = new URL(request.url);
  const type = url.searchParams.get('type') === 'link' ? 'link' : 'key';
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) {
    return jsonResponse({ error: 'Missing id parameter.' }, 400);
  }

  if (type === 'link') {
    await env.DB.prepare('DELETE FROM taplinks WHERE id = ?').bind(id).run();
  } else {
    await env.DB.prepare('DELETE FROM taplink_api_keys WHERE id = ?').bind(id).run();
  }

  return jsonResponse({ ok: true, type, id });
};
