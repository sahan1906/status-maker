import {
  constantTimeEqual,
  getEffectiveBotToken,
  getSetting,
  jsonResponse,
  setSetting,
  upsertUserActivity,
} from '../../_lib/security';
import { PagesHandler } from '../../_lib/types';
import { ensureShortsVideosTable } from '../shorts';

interface TelegramVideoPayload {
  file_id?: string;
  mime_type?: string;
  thumbnail?: { file_id?: string };
  thumb?: { file_id?: string };
}

interface TelegramChannelPost {
  message_id?: number;
  text?: string;
  caption?: string;
  chat?: {
    id: number;
    title?: string;
    type?: string;
  };
  video?: TelegramVideoPayload;
  document?: TelegramVideoPayload;
}

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
  channel_post?: TelegramChannelPost;
  edited_channel_post?: TelegramChannelPost;
}

function parseCaptionTitleAndTags(rawCaption: string): { title: string; tags: string } {
  const text = (rawCaption || '').trim();
  if (!text) {
    return { title: 'Short Reel', tags: '' };
  }

  const tagsFound: string[] = [];
  const withoutTags = text
    .replace(/#([a-zA-Z0-9_]{1,28})/g, (_m, tag: string) => {
      if (tagsFound.length < 6) tagsFound.push(tag.toLowerCase());
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();

  const title = (withoutTags || 'Short Reel').slice(0, 90);
  return { title, tags: Array.from(new Set(tagsFound)).join(',') };
}

function makeWebhookShortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sh_${hex}`;
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

  // 1. Handle Private Channel Posts -> Auto-publish videos to Shorts feed!
  const post = update.channel_post || update.edited_channel_post;
  if (post?.chat?.id !== undefined) {
    const postChatId = String(post.chat.id);
    const postText = (post.text || post.caption || '').trim();

    // Convenience setup command inside your private channel: post "/setshortschannel" once
    if (postText.toLowerCase().startsWith('/setshortschannel')) {
      await setSetting(env.DB, 'shorts_channel_id', postChatId);
      const botToken = await getEffectiveBotToken(env);
      if (botToken) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: postChatId,
            text: `Private Shorts Channel linked (${postChatId}). Any vertical video you post here will automatically appear in your Shorts tab.`,
          }),
        }).catch(() => {});
      }
      return jsonResponse({ ok: true });
    }

    const configuredChannelId = ((await getSetting(env.DB, 'shorts_channel_id')) || '').trim();
    if (configuredChannelId && configuredChannelId === postChatId) {
      const videoObj =
        post.video ||
        (post.document && (post.document.mime_type || '').startsWith('video/')
          ? post.document
          : undefined);

      if (videoObj?.file_id) {
        await ensureShortsVideosTable(env.DB);
        const { title, tags } = parseCaptionTitleAndTags(post.caption || '');
        const posterFileId = videoObj.thumbnail?.file_id || videoObj.thumb?.file_id || '';
        const messageId = typeof post.message_id === 'number' ? post.message_id : null;

        // If editing an existing channel post caption, update the existing row instead of duplicating
        let existingId = '';
        if (messageId !== null) {
          const existing = await env.DB.prepare(
            `SELECT id FROM shorts_videos WHERE telegram_message_id = ?`
          )
            .bind(messageId)
            .first<{ id: string }>();
          if (existing?.id) existingId = existing.id;
        }

        if (existingId) {
          await env.DB.prepare(
            `UPDATE shorts_videos SET title = ?, tags = ?, telegram_file_id = ?, poster_file_id = ? WHERE id = ?`
          )
            .bind(title, tags, videoObj.file_id, posterFileId, existingId)
            .run();
        } else {
          const id = makeWebhookShortId();
          await env.DB.prepare(
            `INSERT INTO shorts_videos (id, title, tags, telegram_file_id, poster_file_id, telegram_message_id, likes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
          )
            .bind(id, title, tags, videoObj.file_id, posterFileId, messageId, Date.now())
            .run();
        }
      }
    }

    return jsonResponse({ ok: true });
  }

  // 2. Handle Direct Bot Messages (/start)
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
