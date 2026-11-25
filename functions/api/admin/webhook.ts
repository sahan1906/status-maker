import {
  getEffectiveBotToken,
  jsonResponse,
  verifyAdminRequest,
} from '../../_lib/security';
import { PagesHandler } from '../../_lib/types';

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const botToken = await getEffectiveBotToken(env);
  if (!botToken) {
    return jsonResponse({ error: 'Save a Telegram Bot Token first.' }, 400);
  }

  const origin = (env.APP_URL || new URL(request.url).origin).replace(/\/$/, '');
  if (!origin.startsWith('https://')) {
    return jsonResponse(
      { error: 'Telegram webhooks require an HTTPS URL (deploy to Cloudflare Pages first).' },
      400
    );
  }

  const webhookUrl = `${origin}/api/telegram/webhook`;
  const payload: Record<string, string> = { url: webhookUrl };
  const secretToken = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (secretToken) {
    payload.secret_token = secretToken;
  }

  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const tgBody = (await tgRes.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
  };

  if (!tgRes.ok || !tgBody.ok) {
    return jsonResponse(
      { error: tgBody.description || 'Failed to register Telegram webhook.' },
      502
    );
  }

  return jsonResponse({
    ok: true,
    webhookUrl,
    description: tgBody.description || 'Webhook registered.',
  });
};
