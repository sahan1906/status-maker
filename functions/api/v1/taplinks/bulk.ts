import {
  buildTapLinkUrls,
  createTapLinkRecord,
  devApiCorsPreflight,
  devApiJsonResponse,
  getTapLinkBaseConfig,
  sanitizeAlias,
  sanitizeTitle,
  validateDestinationUrl,
  verifyDeveloperApiKeyRequest,
} from '../../../_lib/taplinks';
import { PagesHandler } from '../../../_lib/types';

const MAX_BULK_ITEMS = 50;

export const onRequestOptions: PagesHandler = async () => devApiCorsPreflight();

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const auth = await verifyDeveloperApiKeyRequest(request, env.DB);
  if (!auth.ok) {
    return devApiJsonResponse({ ok: false, error: auth.error }, auth.status);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return devApiJsonResponse({ ok: false, error: 'Invalid JSON request body.' }, 400);
  }

  const rawItems = Array.isArray(body.links)
    ? body.links
    : Array.isArray(body.urls)
      ? body.urls
      : null;

  if (!rawItems || rawItems.length === 0) {
    return devApiJsonResponse(
      { ok: false, error: 'Provide a non-empty "links" array (up to 50 items per request).' },
      400
    );
  }

  if (rawItems.length > MAX_BULK_ITEMS) {
    return devApiJsonResponse(
      { ok: false, error: `Maximum ${MAX_BULK_ITEMS} links per bulk request.` },
      400
    );
  }

  // Enforce remaining daily quota across the batch
  if (auth.keyRow.daily_limit > 0) {
    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const usedRow = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM taplinks WHERE creator_type = 'api' AND creator_ref = ? AND created_at >= ?`
    )
      .bind(auth.keyRow.id, dayStart)
      .first<{ cnt: number }>();
    const used24h = Number(usedRow?.cnt) || 0;
    if (used24h + rawItems.length > auth.keyRow.daily_limit) {
      return devApiJsonResponse(
        {
          ok: false,
          error: `Batch exceeds remaining daily quota (${Math.max(0, auth.keyRow.daily_limit - used24h)} remaining of ${auth.keyRow.daily_limit}/24h).`,
        },
        429
      );
    }
  }

  const origin = new URL(request.url).origin;
  const baseCfg = await getTapLinkBaseConfig(env.DB);

  const results: Array<Record<string, unknown>> = [];
  let createdCount = 0;

  for (let i = 0; i < rawItems.length; i += 1) {
    const entry = rawItems[i];
    const rawUrl =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? (entry as Record<string, unknown>).url
          : '';
    const rawTitle =
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>).title : '';
    const rawAlias =
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>).alias : '';

    const validatedUrl = validateDestinationUrl(rawUrl, origin);
    if (!validatedUrl.ok) {
      results.push({ index: i, ok: false, url: rawUrl, error: validatedUrl.error });
      continue;
    }

    const validatedAlias = sanitizeAlias(rawAlias);
    if (!validatedAlias.ok) {
      results.push({ index: i, ok: false, url: validatedUrl.url, error: validatedAlias.error });
      continue;
    }

    const created = await createTapLinkRecord({
      db: env.DB,
      destinationUrl: validatedUrl.url,
      title: sanitizeTitle(rawTitle) || validatedUrl.host,
      alias: validatedAlias.alias,
      creatorType: 'api',
      creatorRef: auth.keyRow.id,
      creatorLabel: `API · ${auth.keyRow.name}`,
    });

    if (!created.ok) {
      results.push({ index: i, ok: false, url: validatedUrl.url, error: created.error });
      continue;
    }

    createdCount += 1;
    const urls = buildTapLinkUrls(
      created.row.code,
      origin,
      baseCfg.botUsername,
      baseCfg.miniAppShortName
    );
    results.push({
      index: i,
      ok: true,
      code: created.row.code,
      title: created.row.title,
      destination_url: created.row.destination_url,
      ...urls,
    });
  }

  if (createdCount > 0) {
    await env.DB.prepare(
      `UPDATE taplink_api_keys
       SET links_created = links_created + ?, last_used_at = ?
       WHERE id = ?`
    )
      .bind(createdCount, Date.now(), auth.keyRow.id)
      .run();
  }

  return devApiJsonResponse(
    {
      ok: true,
      total_requested: rawItems.length,
      created: createdCount,
      failed: rawItems.length - createdCount,
      results,
    },
    createdCount > 0 ? 201 : 400
  );
};
