import { jsonResponse } from '../_lib/security';
import {
  buildTapLinkUrls,
  createTapLinkRecord,
  ensureTapLinksTables,
  extractDestinationHost,
  getTapLinkBaseConfig,
  sanitizeAlias,
  sanitizeTitle,
  TapLinkRow,
  validateDestinationUrl,
} from '../_lib/taplinks';
import { PagesHandler } from '../_lib/types';

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  await ensureTapLinksTables(env.DB);
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim().toLowerCase();
  const codesParam = (url.searchParams.get('codes') || '').trim();
  const baseCfg = await getTapLinkBaseConfig(env.DB);

  // 1. Lookup single short link metadata for the audience ad-unlock screen
  if (code) {
    if (!/^[a-z0-9_-]{3,32}$/.test(code)) {
      return jsonResponse({ error: 'Invalid link code.' }, 400);
    }

    const row = await env.DB.prepare(
      `SELECT id, code, destination_url, title, clicks, unlocks, created_at
       FROM taplinks
       WHERE code = ?`
    )
      .bind(code)
      .first<TapLinkRow>();

    if (!row) {
      return jsonResponse({ error: 'TapLink not found or expired.' }, 404);
    }

    // Record page visit click
    await env.DB.prepare('UPDATE taplinks SET clicks = clicks + 1 WHERE code = ?')
      .bind(code)
      .run();

    const urls = buildTapLinkUrls(row.code, url.origin, baseCfg.botUsername, baseCfg.miniAppShortName);

    return jsonResponse({
      ok: true,
      link: {
        code: row.code,
        title: row.title || extractDestinationHost(row.destination_url) || 'Shared Link',
        destination_host: extractDestinationHost(row.destination_url),
        clicks: (Number(row.clicks) || 0) + 1,
        unlocks: Number(row.unlocks) || 0,
        created_at: new Date(Number(row.created_at) || Date.now()).toISOString(),
        ...urls,
      },
    });
  }

  // 2. Refresh live stats for a user's own created link codes (comma-separated, max 40)
  if (codesParam) {
    const cleanCodes = Array.from(
      new Set(
        codesParam
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter((c) => /^[a-z0-9_-]{3,32}$/.test(c))
      )
    ).slice(0, 40);

    if (cleanCodes.length === 0) {
      return jsonResponse({ ok: true, links: [] });
    }

    const placeholders = cleanCodes.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(
      `SELECT id, code, destination_url, title, clicks, unlocks, created_at
       FROM taplinks
       WHERE code IN (${placeholders})
       ORDER BY created_at DESC`
    )
      .bind(...cleanCodes)
      .all<TapLinkRow>();

    const links = (results || []).map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title || extractDestinationHost(row.destination_url),
      destination_url: row.destination_url,
      destination_host: extractDestinationHost(row.destination_url),
      clicks: Number(row.clicks) || 0,
      unlocks: Number(row.unlocks) || 0,
      created_at: new Date(Number(row.created_at) || Date.now()).toISOString(),
      ...buildTapLinkUrls(row.code, url.origin, baseCfg.botUsername, baseCfg.miniAppShortName),
    }));

    return jsonResponse({ ok: true, links });
  }

  return jsonResponse({ ok: true, links: [] });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'Invalid JSON request body.' }, 400);
  }

  const origin = new URL(request.url).origin;
  const validatedUrl = validateDestinationUrl(body.url, origin);
  if (!validatedUrl.ok) {
    return jsonResponse({ error: validatedUrl.error }, 400);
  }

  const validatedAlias = sanitizeAlias(body.alias);
  if (!validatedAlias.ok) {
    return jsonResponse({ error: validatedAlias.error }, 400);
  }

  const title = sanitizeTitle(body.title) || validatedUrl.host;
  const tgUser = typeof body.creator_ref === 'string' ? body.creator_ref.trim().slice(0, 64) : '';

  const created = await createTapLinkRecord({
    db: env.DB,
    destinationUrl: validatedUrl.url,
    title,
    alias: validatedAlias.alias,
    creatorType: 'app',
    creatorRef: tgUser,
    creatorLabel: tgUser ? `User ${tgUser}` : 'Mini App',
  });

  if (!created.ok) {
    return jsonResponse({ error: created.error }, created.status);
  }

  const baseCfg = await getTapLinkBaseConfig(env.DB);
  const urls = buildTapLinkUrls(
    created.row.code,
    origin,
    baseCfg.botUsername,
    baseCfg.miniAppShortName
  );

  return jsonResponse(
    {
      ok: true,
      link: {
        id: created.row.id,
        code: created.row.code,
        title: created.row.title,
        destination_url: created.row.destination_url,
        destination_host: validatedUrl.host,
        clicks: 0,
        unlocks: 0,
        created_at: new Date(created.row.created_at).toISOString(),
        ...urls,
      },
    },
    201
  );
};
