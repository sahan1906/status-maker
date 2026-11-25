import {
  getEffectiveBotToken,
  jsonResponse,
  upsertUserActivity,
  verifyTelegramInitData,
} from '../_lib/security';
import { PagesHandler } from '../_lib/types';

const MAX_VIDEO_BYTES = 45 * 1024 * 1024; // 45 MB (Telegram Bot API limit is 50 MB)

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
    return jsonResponse({ error: 'Invalid multipart upload payload.' }, 400);
  }

  const videoEntry = formData.get('video');
  const initData = String(formData.get('initData') || '');
  const caption = String(formData.get('caption') || 'Created with ReelCraft').slice(0, 200);

  if (!(videoEntry instanceof File)) {
    return jsonResponse({ error: 'Missing video file.' }, 400);
  }

  if (videoEntry.size <= 0 || videoEntry.size > MAX_VIDEO_BYTES) {
    return jsonResponse({ error: 'Video file exceeds the 45 MB Telegram upload limit.' }, 413);
  }

  if (videoEntry.type && !videoEntry.type.startsWith('video/')) {
    return jsonResponse({ error: 'Unsupported file type. Only MP4/WebM video is accepted.' }, 415);
  }

  // Verify Telegram WebApp initData signature so arbitrary callers cannot spam chats
  const verifiedUser = await verifyTelegramInitData(initData, botToken);
  if (!verifiedUser) {
    return jsonResponse(
      { error: 'Open ReelCraft inside Telegram to send videos directly to your chat.' },
      401
    );
  }

  const tgForm = new FormData();
  tgForm.append('chat_id', verifiedUser.telegramId);
  tgForm.append('caption', caption);
  tgForm.append('supports_streaming', 'true');
  tgForm.append('video', videoEntry, 'ReelCraft-Status.mp4');

  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, {
    method: 'POST',
    body: tgForm,
  });

  const tgBody = (await tgRes.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!tgRes.ok || !tgBody.ok) {
    return jsonResponse(
      { error: tgBody.description || 'Telegram could not deliver the video. Please start the bot first.' },
      502
    );
  }

  await upsertUserActivity(env.DB, verifiedUser.telegramId, verifiedUser.username, 1);

  return jsonResponse({ ok: true, message: 'Video sent to your Telegram chat.' });
};
