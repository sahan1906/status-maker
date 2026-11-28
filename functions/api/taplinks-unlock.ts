import { jsonResponse } from '../_lib/security';
import {
  ensureTapLinksTables,
  TapLinkRow,
  validateDestinationUrl,
} from '../_lib/taplinks';
import { PagesHandler } from '../_lib/types';

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  await ensureTapLinksTables(env.DB);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'Invalid JSON request body.' }, 400);
  }

  const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{3,32}$/.test(code)) {
    return jsonResponse({ error: 'Invalid link code.' }, 400);
  }

  const row = await env.DB.prepare(
    `SELECT id, code, destination_url, title, clicks, unlocks
     FROM taplinks
     WHERE code = ?`
  )
    .bind(code)
    .first<TapLinkRow>();

  if (!row) {
    return jsonResponse({ error: 'TapLink not found.' }, 404);
  }

  // Re-validate stored URL before returning to client
  const checked = validateDestinationUrl(row.destination_url);
  if (!checked.ok) {
    return jsonResponse({ error: 'Destination URL is no longer valid.' }, 400);
  }

  await env.DB.prepare('UPDATE taplinks SET unlocks = unlocks + 1 WHERE code = ?')
    .bind(code)
    .run();

  return jsonResponse({
    ok: true,
    code: row.code,
    title: row.title,
    destination_url: checked.url,
    unlocks: (Number(row.unlocks) || 0) + 1,
  });
};
