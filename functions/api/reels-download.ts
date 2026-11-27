import { jsonResponse } from '../_lib/security';
import { PagesHandler } from '../_lib/types';
import { getPulseShortsBaseUrl } from './reels';

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  // Block RFC1918 & link-local IPv4 ranges to prevent SSRF
  if (
    /^10\./.test(host) ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return true;
  }
  return false;
}

function buildSafeFilename(rawTitle: string): string {
  const slug = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'pulse-short'}.mp4`;
}

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  const reqUrl = new URL(request.url);
  const rawTarget = (reqUrl.searchParams.get('url') || '').trim();
  const rawTitle = (reqUrl.searchParams.get('title') || 'pulse-short').trim();

  if (!rawTarget) {
    return jsonResponse({ error: 'Missing video URL.' }, 400);
  }

  const baseUrl = await getPulseShortsBaseUrl(env.DB);
  let targetUrl: URL;
  try {
    const resolved = rawTarget.startsWith('/') ? `${baseUrl}${rawTarget}` : rawTarget;
    targetUrl = new URL(resolved);
  } catch {
    return jsonResponse({ error: 'Invalid video URL.' }, 400);
  }

  if (targetUrl.protocol !== 'https:' || isBlockedHost(targetUrl.hostname)) {
    return jsonResponse({ error: 'Disallowed video URL host.' }, 403);
  }

  const upstreamHeaders = new Headers({
    'User-Agent': 'ReelCraft-ShortsDownload/1.0',
  });
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    upstreamHeaders.set('Range', rangeHeader);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: upstreamHeaders,
    });
  } catch {
    return jsonResponse({ error: 'Could not download video from upstream.' }, 502);
  }

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return jsonResponse({ error: 'Upstream video unavailable.' }, 502);
  }

  const safeName = buildSafeFilename(rawTitle);
  const headers = new Headers({
    'Content-Type': upstreamRes.headers.get('Content-Type') || 'video/mp4',
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });

  const contentLength = upstreamRes.headers.get('Content-Length');
  if (contentLength) headers.set('Content-Length', contentLength);
  const contentRange = upstreamRes.headers.get('Content-Range');
  if (contentRange) headers.set('Content-Range', contentRange);

  return new Response(upstreamRes.body, {
    status: upstreamRes.status === 206 ? 206 : 200,
    headers,
  });
};
