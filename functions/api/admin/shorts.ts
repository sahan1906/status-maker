import {
  getEffectiveBotToken,
  getSetting,
  jsonResponse,
  setSetting,
  verifyAdminRequest,
} from '../../_lib/security';
import { PagesHandler } from '../../_lib/types';
import {
  ensureShortsVideosTable,
  formatShortVideoRow,
  ShortsVideoRow,
} from '../shorts';

const MAX_UPLOAD_BYTES = 19.5 * 1024 * 1024; // Telegram Bot API getFile 20MB limit

function makeShortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sh_${hex}`;
}

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  if (!(await verifyAdminRequest(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureShortsVideosTable(env.DB);
  const [{ results }, channelId] = await Promise.all([
    env.DB.prepare(
      `SELECT id, title, tags, telegram_file_id, poster_file_id, telegram_message_id, likes, created_at
       FROM shorts_videos
       ORDER BY created_at DESC`
    ).all<ShortsVideoRow>(),
    getSetting(env.DB, 'shorts_channel_id'),
  ]);

  return jsonResponse({
    ok: true,
    shorts_channel_id: channelId || '',
    videos: (results || []).map(formatShortVideoRow),
  });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  if (!(await verifyAdminRequest(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureShortsVideosTable(env.DB);
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Upload an MP4 video file using multipart/form-data.' }, 400);
  }

  const form = await request.formData();
  const title = String(form.get('title') || '').trim().slice(0, 90) || 'Short Reel';
  const rawTags = String(form.get('tags') || '').trim().slice(0, 120);
  const channelInput = String(form.get('shorts_channel_id') || '').trim();
  const fileEntry = form.get('video');

  if (!(fileEntry instanceof File) || fileEntry.size <= 0) {
    return jsonResponse({ error: 'Please select an MP4 video file to upload.' }, 400);
  }
  if (fileEntry.size > MAX_UPLOAD_BYTES) {
    return jsonResponse(
      { error: 'Video must be under 19.5 MB for Telegram Bot streaming.' },
      413
    );
  }

  const botToken = await getEffectiveBotToken(env);
  if (!botToken) {
    return jsonResponse(
      { error: 'Configure your Telegram Bot Token in Settings first.' },
      400
    );
  }

  let targetChatId = channelInput || (await getSetting(env.DB, 'shorts_channel_id')) || '';
  if (channelInput) {
    await setSetting(env.DB, 'shorts_channel_id', channelInput);
  }

  if (!targetChatId) {
    return jsonResponse(
      {
        error:
          'Set your Private Shorts Channel ID first (or post /setshortschannel inside your private channel with your bot added as admin).',
      },
      400
    );
  }

  const tgForm = new FormData();
  tgForm.append('chat_id', targetChatId);
  tgForm.append('video', fileEntry, fileEntry.name || 'short.mp4');
  tgForm.append('supports_streaming', 'true');
  tgForm.append('caption', rawTags ? `${title}\n${rawTags}` : title);

  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
    method: 'POST',
    body: tgForm,
  });

  const tgBody = (await tgRes.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: {
      message_id?: number;
      video?: {
        file_id?: string;
        thumbnail?: { file_id?: string };
        thumb?: { file_id?: string };
      };
      document?: {
        file_id?: string;
        thumbnail?: { file_id?: string };
      };
    };
  };

  if (!tgRes.ok || !tgBody.ok) {
    return jsonResponse(
      {
        error:
          tgBody.description ||
          'Telegram rejected the upload. Make sure your bot is an Admin in your private channel.',
      },
      502
    );
  }

  const fileId = tgBody.result?.video?.file_id || tgBody.result?.document?.file_id || '';
  const posterFileId =
    tgBody.result?.video?.thumbnail?.file_id ||
    tgBody.result?.video?.thumb?.file_id ||
    tgBody.result?.document?.thumbnail?.file_id ||
    '';
  const messageId = tgBody.result?.message_id ?? null;

  if (!fileId) {
    return jsonResponse({ error: 'Telegram did not return a video file_id.' }, 502);
  }

  const id = makeShortId();
  const createdAt = Date.now();
  const cleanTags = rawTags
    .split(/[,\s]+/)
    .map((t) => t.trim().replace(/^#+/, ''))
    .filter(Boolean)
    .slice(0, 6)
    .join(',');

  await env.DB.prepare(
    `INSERT INTO shorts_videos (id, title, tags, telegram_file_id, poster_file_id, telegram_message_id, likes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(id, title, cleanTags, fileId, posterFileId, messageId, createdAt)
    .run();

  return jsonResponse({
    ok: true,
    video: formatShortVideoRow({
      id,
      title,
      tags: cleanTags,
      telegram_file_id: fileId,
      poster_file_id: posterFileId,
      telegram_message_id: messageId,
      likes: 0,
      created_at: createdAt,
    }),
  });
};

export const onRequestDelete: PagesHandler = async ({ request, env }) => {
  if (!(await verifyAdminRequest(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]{3,64}$/.test(id)) {
    return jsonResponse({ error: 'Invalid short ID.' }, 400);
  }

  await ensureShortsVideosTable(env.DB);
  await env.DB.prepare(`DELETE FROM shorts_videos WHERE id = ?`).bind(id).run();
  return jsonResponse({ ok: true, id });
};
