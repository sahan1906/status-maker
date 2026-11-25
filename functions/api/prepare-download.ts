import {
  getEffectiveBotToken,
  jsonResponse,
  signDownloadToken,
  upsertUserActivity,
  verifyTelegramInitData,
} from '../_lib/security';
import { PagesHandler } from '../_lib/types';

// Telegram Bot API getFile supports up to 20 MB
const MAX_DIRECT_DOWNLOAD_BYTES = 19.5 * 1024 * 1024;
const DOWNLOAD_LINK_TTL_MS = 10 * 60 * 1000; // 10 minutes

function sanitizeFileName(raw: string): string {
  const base = (raw || 'ReelCraft-Status.mp4')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return 'ReelCraft-Status.mp4';
  return base.toLowerCase().endsWith('.mp4') || base.toLowerCase().endsWith('.webm')
    ? base
    : `${base}.mp4`;
}

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const botToken = await getEffectiveBotToken(env);
  if (!botToken) {
    return jsonResponse(
      { error: 'Telegram Bot Token is not configured yet. Set it in /admin settings.' },
      503
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'Invalid upload payload.' }, 400);
  }

  const videoEntry = formData.get('video');
  const initData = String(formData.get('initData') || '');
  const requestedName = String(formData.get('fileName') || 'ReelCraft-Status.mp4');

  if (!(videoEntry instanceof File)) {
    return jsonResponse({ error: 'Missing video file.' }, 400);
  }

  if (videoEntry.size <= 0) {
    return jsonResponse({ error: 'Empty video file.' }, 400);
  }

  if (videoEntry.size > MAX_DIRECT_DOWNLOAD_BYTES) {
    return jsonResponse(
      {
        error:
          'Video is larger than 19 MB for direct download. Tap "Send to My Telegram Chat" above instead.',
      },
      413
    );
  }

  if (videoEntry.type && !videoEntry.type.startsWith('video/')) {
    return jsonResponse({ error: 'Unsupported file type.' }, 415);
  }

  const verifiedUser = await verifyTelegramInitData(initData, botToken);
  if (!verifiedUser) {
    return jsonResponse(
      { error: 'Open inside Telegram to use native Telegram download.' },
      401
    );
  }

  const safeName = sanitizeFileName(requestedName);

  // Upload silently via sendDocument so Telegram preserves exact untouched MP4 bytes,
  // then immediately delete the temporary message so the user's chat stays clean.
  const tgForm = new FormData();
  tgForm.append('chat_id', verifiedUser.telegramId);
  tgForm.append('disable_notification', 'true');
  tgForm.append('document', videoEntry, safeName);

  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: 'POST',
    body: tgForm,
  });

  const tgBody = (await tgRes.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: {
      message_id?: number;
      document?: { file_id?: string };
      video?: { file_id?: string };
    };
  };

  const fileId = tgBody.result?.document?.file_id || tgBody.result?.video?.file_id;
  const messageId = tgBody.result?.message_id;

  if (!tgRes.ok || !tgBody.ok || !fileId) {
    return jsonResponse(
      {
        error:
          tgBody.description ||
          'Could not prepare direct download. Start the bot with /start or use Send to Telegram Chat.',
      },
      502
    );
  }

  // Delete the temporary upload message immediately so user's chat stays uncluttered
  if (messageId) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: verifiedUser.telegramId,
          message_id: messageId,
        }),
      });
    } catch {
      // Non-fatal if Telegram disallows deleting
    }
  }

  const exp = Date.now() + DOWNLOAD_LINK_TTL_MS;
  const sig = await signDownloadToken(env, fileId, exp, safeName);
  const origin = (env.APP_URL || new URL(request.url).origin).replace(/\/$/, '');
  const params = new URLSearchParams({
    fid: fileId,
    exp: String(exp),
    name: safeName,
    sig,
  });

  await upsertUserActivity(env.DB, verifiedUser.telegramId, verifiedUser.username, 1);

  return jsonResponse({
    ok: true,
    downloadUrl: `${origin}/api/download-video?${params.toString()}`,
    fileName: safeName,
  });
};
