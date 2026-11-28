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

  const origin = new URL(request.url).origin;
  const validatedUrl = validateDestinationUrl(body.url, origin);
  if (!validatedUrl.ok) {
    return devApiJsonResponse({ ok: false, error: validatedUrl.error }, 400);
  }

  const validatedAlias = sanitizeAlias(body.alias);
  if (!validatedAlias.ok) {
    return devApiJsonResponse({ ok: false, error: validatedAlias.error }, 400);
  }

  const title = sanitizeTitle(body.title) || validatedUrl.host;
  const created = await createTapLinkRecord({
    db: env.DB,
    destinationUrl: validatedUrl.url,
    title,
    alias: validatedAlias.alias,
    creatorType: 'api',
    creatorRef: auth.keyRow.id,
    creatorLabel: `API · ${auth.keyRow.name}`,
  });

  if (!created.ok) {
    return devApiJsonResponse({ ok: false, error: created.error }, created.status);
  }

  await env.DB.prepare(
    `UPDATE taplink_api_keys
     SET links_created = links_created + 1, last_used_at = ?
     WHERE id = ?`
  )
    .bind(Date.now(), auth.keyRow.id)
    .run();

  const baseCfg = await getTapLinkBaseConfig(env.DB);
  const urls = buildTapLinkUrls(
    created.row.code,
    origin,
    baseCfg.botUsername,
    baseCfg.miniAppShortName
  );

  return devApiJsonResponse(
    {
      ok: true,
      code: created.row.code,
      title: created.row.title,
      destination_url: created.row.destination_url,
      ...urls,
      created_at: new Date(created.row.created_at).toISOString(),
    },
    201
  );
};
