import {
  getEffectiveBotToken,
  jsonResponse,
  verifyAdminRequest,
} from '../../_lib/security';
import { PagesHandler } from '../../_lib/types';

// Strictly cap at 25 users per batch to stay safely below Cloudflare Free Tier's 50-subrequest limit
const BATCH_LIMIT = 25;

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const botToken = await getEffectiveBotToken(env);
  if (!botToken) {
    return jsonResponse({ error: 'Configure your Telegram Bot Token before broadcasting.' }, 400);
  }

  let body: { message?: string; offset?: number };
  try {
    body = (await request.json()) as { message?: string; offset?: number };
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1000) : '';
  const offset =
    typeof body.offset === 'number' && Number.isFinite(body.offset) && body.offset >= 0
      ? Math.floor(body.offset)
      : 0;

  if (!message) {
    return jsonResponse({ error: 'Broadcast message cannot be empty.' }, 400);
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS total FROM users').first<{
    total: number;
  }>();
  const total = Number(countRow?.total || 0);

  const { results } = await env.DB.prepare(
    'SELECT telegram_id FROM users ORDER BY created_at ASC LIMIT ? OFFSET ?'
  )
    .bind(BATCH_LIMIT, offset)
    .all<{ telegram_id: string }>();

  let sent = 0;
  let failed = 0;

  await Promise.all(
    results.map(async (row) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: row.telegram_id,
            text: message,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
        if (res.ok && data.ok) {
          sent += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    })
  );

  const nextOffset = offset + results.length;
  const done = results.length < BATCH_LIMIT || nextOffset >= total;

  return jsonResponse({
    ok: true,
    sent,
    failed,
    processed: results.length,
    total,
    nextOffset,
    done,
  });
};
