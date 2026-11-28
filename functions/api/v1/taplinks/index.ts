import {
  buildTapLinkUrls,
  devApiCorsPreflight,
  devApiJsonResponse,
  extractDestinationHost,
  getTapLinkBaseConfig,
  TapLinkRow,
  verifyDeveloperApiKeyRequest,
} from '../../../_lib/taplinks';
import { PagesHandler } from '../../../_lib/types';

export const onRequestOptions: PagesHandler = async () => devApiCorsPreflight();

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  const auth = await verifyDeveloperApiKeyRequest(request, env.DB, { enforceQuota: false });
  if (!auth.ok) {
    return devApiJsonResponse({ ok: false, error: auth.error }, auth.status);
  }

  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
  const rawOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

  const [countRow, listRes] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as total FROM taplinks WHERE creator_type = 'api' AND creator_ref = ?`
    )
      .bind(auth.keyRow.id)
      .first<{ total: number }>(),
    env.DB.prepare(
      `SELECT id, code, destination_url, title, clicks, unlocks, created_at
       FROM taplinks
       WHERE creator_type = 'api' AND creator_ref = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(auth.keyRow.id, limit, offset)
      .all<TapLinkRow>(),
  ]);

  const baseCfg = await getTapLinkBaseConfig(env.DB);
  const links = (listRes.results || []).map((row) => ({
    code: row.code,
    title: row.title,
    destination_url: row.destination_url,
    destination_host: extractDestinationHost(row.destination_url),
    clicks: Number(row.clicks) || 0,
    unlocks: Number(row.unlocks) || 0,
    created_at: new Date(Number(row.created_at) || Date.now()).toISOString(),
    ...buildTapLinkUrls(row.code, url.origin, baseCfg.botUsername, baseCfg.miniAppShortName),
  }));

  return devApiJsonResponse({
    ok: true,
    partner: auth.keyRow.name,
    daily_limit: auth.keyRow.daily_limit,
    total: Number(countRow?.total) || 0,
    offset,
    limit,
    links,
  });
};
