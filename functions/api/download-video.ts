import {
  getEffectiveBotToken,
  jsonResponse,
  verifyDownloadToken,
} from '../_lib/security';
import { PagesHandler } from '../_lib/types';

async function handleDownload(request: Request, env: Parameters<PagesHandler>[0]['env'], isHead: boolean): Promise<Response> {
  const url = new URL(request.url);
  const fileId = (url.searchParams.get('fid') || '').trim();
  const exp = Number(url.searchParams.get('exp') || '0');
  const fileName = (url.searchParams.get('name') || 'ReelCraft-Status.mp4')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'ReelCraft-Status.mp4';
  const sig = (url.searchParams.get('sig') || '').trim();

  const valid = await verifyDownloadToken(env, fileId, exp, fileName, sig);
  if (!valid) {
    return jsonResponse({ error: 'Download link expired or invalid.' }, 403);
  }

  const copyRaw = (url.searchParams.get('copy') || '').trim();
  const copyNum = /^[2-9]\d{0,4}$|^1\d{1,4}$/.test(copyRaw) ? copyRaw : '';
  const downloadFileName = copyNum
    ? fileName.replace(/(\.[a-z0-9]+)$/i, `-${copyNum}$1`)
    : fileName;

  const botToken = await getEffectiveBotToken(env);
  if (!botToken) {
    return jsonResponse({ error: 'Bot token not configured.' }, 503);
  }

  const metaRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const metaBody = (await metaRes.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
  };

  const filePath = metaBody.result?.file_path;
  if (!metaRes.ok || !metaBody.ok || !filePath) {
    return jsonResponse({ error: 'Video file is no longer available.' }, 404);
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
    method: isHead ? 'HEAD' : 'GET',
  });

  if (!fileRes.ok) {
    return jsonResponse({ error: 'Could not retrieve video stream.' }, 502);
  }

  const contentType = downloadFileName.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${downloadFileName}"`,
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Origin': '*',
  });

  const contentLength = fileRes.headers.get('Content-Length') ||
    (metaBody.result?.file_size ? String(metaBody.result.file_size) : '');
  if (contentLength) {
    headers.set('Content-Length', contentLength);
  }

  return new Response(isHead ? null : fileRes.body, {
    status: 200,
    headers,
  });
}

export const onRequestGet: PagesHandler = async ({ request, env }) =>
  handleDownload(request, env, false);

export const onRequestHead: PagesHandler = async ({ request, env }) =>
  handleDownload(request, env, true);
