import {
  constantTimeEqual,
  getSetting,
  hashPassword,
  issueAdminToken,
  jsonResponse,
  setSetting,
  verifyPasswordHash,
} from '../../_lib/security';
import { PagesHandler } from '../../_lib/types';

export const onRequestGet: PagesHandler = async ({ env }) => {
  const envPassword = (env.ADMIN_PASSWORD || '').trim();
  if (envPassword) {
    return jsonResponse({ needsSetup: false, envControlled: true });
  }
  const storedHash = await getSetting(env.DB, 'admin_password_hash');
  return jsonResponse({
    needsSetup: !storedHash,
    envControlled: false,
  });
};

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  let body: { action?: string; password?: string };
  try {
    body = (await request.json()) as { action?: string; password?: string };
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const password = typeof body.password === 'string' ? body.password : '';
  const action = body.action === 'bootstrap' ? 'bootstrap' : 'login';
  const envPassword = (env.ADMIN_PASSWORD || '').trim();

  if (action === 'bootstrap') {
    if (envPassword) {
      return jsonResponse({ error: 'Admin password is already managed by environment secret.' }, 403);
    }
    const existingHash = await getSetting(env.DB, 'admin_password_hash');
    if (existingHash) {
      return jsonResponse({ error: 'Admin setup has already been completed.' }, 403);
    }
    if (password.trim().length < 8) {
      return jsonResponse({ error: 'Choose an admin password of at least 8 characters.' }, 400);
    }

    const hashed = await hashPassword(password);
    await setSetting(env.DB, 'admin_password_hash', hashed);
    const token = await issueAdminToken(env);
    return jsonResponse({ ok: true, token });
  }

  // Standard login flow (env secret always takes precedence over claimed fallback hash)
  if (!password) {
    return jsonResponse({ error: 'Password is required.' }, 400);
  }

  let valid = false;
  if (envPassword) {
    valid = constantTimeEqual(password, envPassword);
  } else {
    const storedHash = await getSetting(env.DB, 'admin_password_hash');
    if (!storedHash) {
      return jsonResponse({ error: 'Admin password has not been set up yet.' }, 403);
    }
    valid = await verifyPasswordHash(password, storedHash);
  }

  if (!valid) {
    return jsonResponse({ error: 'Invalid admin password.' }, 401);
  }

  const token = await issueAdminToken(env);
  return jsonResponse({ ok: true, token });
};
