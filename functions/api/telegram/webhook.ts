import {
  constantTimeEqual,
  getEffectiveBotToken,
  getSetting,
  jsonResponse,
  upsertUserActivity,
} from '../../_lib/security';
import { PagesHandler } from '../../_lib/types';

interface TelegramUpdate {
  message?: {
    text?: string;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
    };
    chat?: {
      id: number;
    };
  };
}

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  // Optional webhook secret header verification
  const expectedSecret = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (expectedSecret) {
    const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!constantTimeEqual(provided, expectedSecret)) {
      return jsonResponse({ error: 'Unauthorized webhook request' }, 401);
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return jsonResponse({ ok: true });
  }

  const msg = update.message;
  const chatId = msg?.chat?.id ?? msg?.from?.id;
  if (!chatId) {
    return jsonResponse({ ok: true });
  }

  const telegramId = String(chatId);
  const username = msg?.from?.username || msg?.from?.first_name || '';

  await upsertUserActivity(env.DB, telegramId, username, 0);

  const text = (msg?.text || '').trim();
  if (text.startsWith('/start')) {
    const botToken = await getEffectiveBotToken(env);
    if (botToken) {
      const siteName = (await getSetting(env.DB, 'site_name')) || 'ReelCraft';
      const origin = (env.APP_URL || new URL(request.url).origin).replace(/\/$/, '');

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Welcome to ${siteName}.\n\nTurn up to 50 photos into cinematic 9:16 status videos for WhatsApp Status & Instagram Reels in seconds.`,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Create Status Video',
                  web_app: { url: origin },
                },
              ],
            ],
          },
        }),
      });
    }
  }

  return jsonResponse({ ok: true });
};
