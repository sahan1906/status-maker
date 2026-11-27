import { getEffectiveBotToken, jsonResponse } from '../_lib/security';
import { PagesHandler } from '../_lib/types';
import { ensureShortsVideosTable, ShortsVideoRow } from './shorts';

// In-isolate Telegram file_path cache (Telegram keeps file_path valid for at least 1 hour)
const filePathCache = new Map<string, { path: string; expiresAt: number }>();

async function resolveTelegramFilePath(botToken: string, fileId: string): Promise<string | null> {
  const now = Date.now();
  const cached = filePathCache.get(fileId);
  if (cached && cached.expiresAt > now) {
    return cached.path;
  }

  const metaRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const metaBody = (await metaRes.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { file_path?: string };
  };

  const filePath = metaBody.result?.file_path;
  if (!metaRes.ok || !metaBody.ok || !filePath) {
    return null;
  }

  filePathCache.set(fileId, { path: filePath, expiresAt: now + 30 * 60 * 1000 });
  if (filePathCache.size > 300) {
    const firstKey = filePathCache.keys().next().value;
    if (firstKey) filePathCache.delete(firstKey);
  }
  return filePath;
}

function buildSafeFilename(rawTitle: string): string {
  const slug = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'short-reel'}.mp4`;
}

async function handleStream(
  request: Request,
  env: Parameters<PagesHandler>[0]['env'],
  isHead: boolean
): Promise<Response> {
  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  const kind = url.searchParams.get('kind') === 'poster' ? 'poster' : 'video';
  const asDownload = url.searchParams.get('download') === '1';

  if (!id || !/^[a-zA-Z0-9_-]{3,64}$/.test(id)) {
    return jsonResponse({ error: 'Invalid short ID.' }, 400);
  }

  await ensureShortsVideosTable(env.DB);
  const row = await env.DB.prepare(
    `SELECT id, title, telegram_file_id, poster_file_id FROM shorts_videos WHERE id = ?`
  )
    .bind(id)
    .first<Pick<ShortsVideoRow, 'id' | 'title' | 'telegram_file_id' | 'poster_file_id'>>();

  if (!row) {
    return jsonResponse({ error: 'Short not found.' }, 404);
  }

  const fileId = kind === 'poster' ? row.poster_file_id : row.telegram_file_id;
  if (!fileId) {
    return jsonResponse({ error: 'Media not available.' }, 404);
  }

  const botToken = await getEffectiveBotToken(env);
  if (!botToken) {
    return jsonResponse({ error: 'Telegram Bot Token is not configured.' }, 503);
  }

  const filePath = await resolveTelegramFilePath(botToken, fileId);
  if (!filePath) {
    return jsonResponse({ error: 'Telegram file is unavailable.' }, 404);
  }

  const upstreamUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const upstreamHeaders = new Headers();
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader && kind === 'video') {
    upstreamHeaders.set('Range', rangeHeader);
  }

  const upstreamRes = await fetch(upstreamUrl, {
    method: isHead ? 'HEAD' : 'GET',
    headers: upstreamHeaders,
  });

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    // Invalidate cached file_path in case it expired early
    filePathCache.delete(fileId);
    return jsonResponse({ error: 'Could not stream video from Telegram.' }, 502);
  }

  const defaultContentType = kind === 'poster' ? 'image/jpeg' : 'video/mp4';
  const headers = new Headers({
    'Content-Type': upstreamRes.headers.get('Content-Type') || defaultContentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });

  if (asDownload && kind === 'video') {
    headers.set('Content-Disposition', `attachment; filename="${buildSafeFilename(row.title)}"`);
    headers.set('Cache-Control', 'no-store');
  }

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
  handleStream(request, env, false);

export const onRequestHead: PagesHandler = async ({ request, env }) =>
  handleStream(request, env, true);
