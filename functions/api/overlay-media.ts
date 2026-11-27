import { getEffectiveBotToken, jsonResponse } from '../_lib/security';
import { PagesHandler } from '../_lib/types';
import { ensureOverlayTemplatesTable, OverlayTemplateRow } from './overlays';

async function streamOverlayMedia(
  request: Request,
  env: Parameters<PagesHandler>[0]['env'],
  isHead: boolean
): Promise<Response> {
  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]{4,64}$/.test(id)) {
    return jsonResponse({ error: 'Invalid overlay ID.' }, 400);
  }

  await ensureOverlayTemplatesTable(env.DB);
  const row = await env.DB.prepare(
    `SELECT id, video_url, telegram_file_id FROM overlay_templates WHERE id = ?`
  )
    .bind(id)
    .first<Pick<OverlayTemplateRow, 'id' | 'video_url' | 'telegram_file_id'>>();

  if (!row) {
    return jsonResponse({ error: 'Overlay template not found.' }, 404);
  }

  let upstreamUrl = '';
  if (row.telegram_file_id) {
    const botToken = await getEffectiveBotToken(env);
    if (!botToken) {
      return jsonResponse({ error: 'Bot token not configured.' }, 503);
    }
    const metaRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(row.telegram_file_id)}`
    );
    const metaBody = (await metaRes.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { file_path?: string };
    };
    const filePath = metaBody.result?.file_path;
    if (!metaRes.ok || !metaBody.ok || !filePath) {
      return jsonResponse({ error: 'Overlay video file is unavailable.' }, 404);
    }
    upstreamUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  } else if (row.video_url) {
    try {
      const parsed = new URL(row.video_url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return jsonResponse({ error: 'Invalid overlay media URL.' }, 400);
      }
      upstreamUrl = parsed.toString();
    } catch {
      return jsonResponse({ error: 'Invalid overlay media URL.' }, 400);
    }
  } else {
    return jsonResponse({ error: 'Overlay media missing.' }, 404);
  }

  const upstreamHeaders = new Headers();
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    upstreamHeaders.set('Range', rangeHeader);
  }

  const upstreamRes = await fetch(upstreamUrl, {
    method: isHead ? 'HEAD' : 'GET',
    headers: upstreamHeaders,
  });

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return jsonResponse({ error: 'Could not load overlay video stream.' }, 502);
  }

  const headers = new Headers({
    'Content-Type': upstreamRes.headers.get('Content-Type') || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });

  const contentLength = upstreamRes.headers.get('Content-Length');
  if (contentLength) headers.set('Content-Length', contentLength);
  const contentRange = upstreamRes.headers.get('Content-Range');
  if (contentRange) headers.set('Content-Range', contentRange);

  return new Response(isHead ? null : upstreamRes.body, {
    status: upstreamRes.status === 206 ? 206 : 200,
    headers,
  });
}

export const onRequestGet: PagesHandler = async ({ request, env }) =>
  streamOverlayMedia(request, env, false);

export const onRequestHead: PagesHandler = async ({ request, env }) =>
  streamOverlayMedia(request, env, true);
