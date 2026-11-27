import {
  getEffectiveBotToken,
  getSetting,
  jsonResponse,
  setSetting,
  verifyAdminRequest,
} from '../../_lib/security';
import { PagesHandler } from '../../_lib/types';
import { ensureOverlayTemplatesTable, OverlayTemplateRow } from '../overlays';

const MAX_UPLOAD_BYTES = 19.5 * 1024 * 1024; // Telegram Bot API getFile 20MB limit

function makeOverlayId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `ov_${hex}`;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  if (!(await verifyAdminRequest(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureOverlayTemplatesTable(env.DB);
  const [{ results }, storageChatId] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, tagline, badge, video_url, telegram_file_id, fit_mode, chroma_sensitivity, accent_color, default_title, created_at
       FROM overlay_templates
       ORDER BY created_at DESC`
    ).all<OverlayTemplateRow>(),
    getSetting(env.DB, 'overlay_storage_chat_id'),
  ]);

  const overlays = results.map((row) => ({
    ...row,
    fit_mode: row.fit_mode === 'detected-rect' ? 'detected-rect' : 'full-frame',
    source_type: row.telegram_file_id ? 'telegram' : 'url',
    stream_url: `/api/overlay-media?id=${encodeURIComponent(row.id)}`,
  }));

  return jsonResponse({
    ok: true,
    storage_chat_id: storageChatId || '',
    overlays,
  });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  if (!(await verifyAdminRequest(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureOverlayTemplatesTable(env.DB);

  const contentType = request.headers.get('Content-Type') || '';
  let name = '';
  let tagline = '';
  let badge = 'AI Overlay';
  let fitMode: 'full-frame' | 'detected-rect' = 'full-frame';
  let chromaSensitivity = 0.55;
  let accentColor = '#F472B6';
  let defaultTitle = '';
  let videoUrl = '';
  let storageChatId = '';
  let videoFile: File | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    name = String(form.get('name') || '').trim().slice(0, 48);
    tagline = String(form.get('tagline') || '').trim().slice(0, 120);
    badge = String(form.get('badge') || 'AI Overlay').trim().slice(0, 20) || 'AI Overlay';
    fitMode = String(form.get('fit_mode') || '') === 'detected-rect' ? 'detected-rect' : 'full-frame';
    chromaSensitivity = Math.max(
      0.15,
      Math.min(0.95, Number(form.get('chroma_sensitivity') || 0.55) || 0.55)
    );
    accentColor = /^#[0-9a-fA-F]{6}$/.test(String(form.get('accent_color') || '').trim())
      ? String(form.get('accent_color')).trim()
      : '#F472B6';
    defaultTitle = String(form.get('default_title') || '').trim().slice(0, 36);
    videoUrl = String(form.get('video_url') || '').trim();
    storageChatId = String(form.get('storage_chat_id') || '').trim();
    const fileEntry = form.get('video');
    if (fileEntry instanceof File && fileEntry.size > 0) {
      videoFile = fileEntry;
    }
  } else {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    name = String(body.name || '').trim().slice(0, 48);
    tagline = String(body.tagline || '').trim().slice(0, 120);
    badge = String(body.badge || 'AI Overlay').trim().slice(0, 20) || 'AI Overlay';
    fitMode = body.fit_mode === 'detected-rect' ? 'detected-rect' : 'full-frame';
    chromaSensitivity = Math.max(
      0.15,
      Math.min(0.95, Number(body.chroma_sensitivity ?? 0.55) || 0.55)
    );
    accentColor =
      typeof body.accent_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.accent_color.trim())
        ? body.accent_color.trim()
        : '#F472B6';
    defaultTitle = String(body.default_title || '').trim().slice(0, 36);
    videoUrl = String(body.video_url || '').trim();
    storageChatId = String(body.storage_chat_id || '').trim();
  }

  if (!name) {
    return jsonResponse({ error: 'Please enter a template name (e.g. AI Girl Birthday Wish).' }, 400);
  }

  let telegramFileId = '';

  if (videoFile) {
    if (videoFile.size > MAX_UPLOAD_BYTES) {
      return jsonResponse(
        { error: 'Video must be under 19.5 MB for direct upload. Compress it or use a Direct MP4 URL.' },
        413
      );
    }

    const botToken = await getEffectiveBotToken(env);
    if (!botToken) {
      return jsonResponse(
        { error: 'Set your Telegram Bot Token in Settings first, or paste a Direct MP4 URL.' },
        400
      );
    }

    let resolvedChatId = storageChatId || (await getSetting(env.DB, 'overlay_storage_chat_id')) || '';
    if (!resolvedChatId) {
      // Auto-fallback to the most recently active Telegram user (usually the bot owner!)
      const fallbackUser = await env.DB.prepare(
        `SELECT telegram_id FROM users ORDER BY created_at ASC LIMIT 1`
      ).first<{ telegram_id: string }>();
      resolvedChatId = fallbackUser?.telegram_id || '';
    }

    if (!resolvedChatId) {
      return jsonResponse(
        {
          error:
            'Enter your Telegram Chat ID (or send /start to your bot once) so the bot can host the MP4 for free.',
        },
        400
      );
    }

    if (storageChatId) {
      await setSetting(env.DB, 'overlay_storage_chat_id', storageChatId);
    }

    const safeName =
      videoFile.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'overlay.mp4';
    const tgForm = new FormData();
    tgForm.append('chat_id', resolvedChatId);
    tgForm.append('disable_notification', 'true');
    tgForm.append('caption', `ReelCraft Overlay: ${name}`);
    tgForm.append('document', videoFile, safeName);

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: tgForm,
    });
    const tgBody = (await tgRes.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { document?: { file_id?: string }; video?: { file_id?: string } };
    };

    telegramFileId = tgBody.result?.document?.file_id || tgBody.result?.video?.file_id || '';
    if (!tgRes.ok || !tgBody.ok || !telegramFileId) {
      return jsonResponse(
        {
          error:
            tgBody.description ||
            'Telegram upload failed. Make sure you sent /start to your bot or check the Chat ID.',
        },
        502
      );
    }
    videoUrl = '';
  } else {
    if (!videoUrl || !isValidHttpUrl(videoUrl)) {
      return jsonResponse(
        { error: 'Please upload an MP4 video file OR paste a valid https:// MP4 URL.' },
        400
      );
    }
  }

  const id = makeOverlayId();
  await env.DB.prepare(
    `INSERT INTO overlay_templates (id, name, tagline, badge, video_url, telegram_file_id, fit_mode, chroma_sensitivity, accent_color, default_title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      name,
      tagline || 'Premade green-screen video — drop your photo or video behind it',
      badge,
      videoUrl,
      telegramFileId,
      fitMode,
      chromaSensitivity,
      accentColor,
      defaultTitle
    )
    .run();

  return jsonResponse({
    ok: true,
    overlay: {
      id,
      name,
      tagline: tagline || 'Premade green-screen video — drop your photo or video behind it',
      badge,
      fit_mode: fitMode,
      chroma_sensitivity: chromaSensitivity,
      accent_color: accentColor,
      default_title: defaultTitle,
      source_type: telegramFileId ? 'telegram' : 'url',
      stream_url: `/api/overlay-media?id=${encodeURIComponent(id)}`,
    },
  });
};

export const onRequestDelete: PagesHandler = async ({ request, env }) => {
  if (!(await verifyAdminRequest(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  await ensureOverlayTemplatesTable(env.DB);
  const url = new URL(request.url);
  let id = (url.searchParams.get('id') || '').trim();
  if (!id) {
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    id = String(body.id || '').trim();
  }

  if (!id) {
    return jsonResponse({ error: 'Missing overlay ID.' }, 400);
  }

  await env.DB.prepare(`DELETE FROM overlay_templates WHERE id = ?`).bind(id).run();
  return jsonResponse({ ok: true, id });
};
