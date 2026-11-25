import { D1Database, Env } from './types';

const encoder = new TextEncoder();

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(new ArrayBuffer(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `pbkdf2_sha256$${toHex(salt)}$${toHex(derived)}`;
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2_sha256') return false;
  const salt = fromHex(parts[1]);
  const expectedHex = parts[2];

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return constantTimeEqual(toHex(derived), expectedHex);
}

let runtimeFallbackSecret: string | null = null;

function getSigningSecret(env: Env, persistedSecret?: string | null): string {
  if (env.SESSION_SECRET && env.SESSION_SECRET.trim()) return env.SESSION_SECRET.trim();
  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.trim()) return `rc_sig_${env.ADMIN_PASSWORD.trim()}`;
  if (persistedSecret && persistedSecret.trim()) return persistedSecret.trim();
  if (!runtimeFallbackSecret) {
    runtimeFallbackSecret = toHex(crypto.getRandomValues(new Uint8Array(32)));
  }
  return runtimeFallbackSecret;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(sig);
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row ? row.value : null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .bind(key, value)
    .run();
}

export async function getAllSettingsMap(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db
    .prepare('SELECT key, value FROM app_settings')
    .all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const row of results) {
    map[row.key] = row.value;
  }
  return map;
}

export async function ensureSigningSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET?.trim() || env.ADMIN_PASSWORD?.trim()) {
    return getSigningSecret(env);
  }
  let stored = await getSetting(env.DB, 'internal_session_secret');
  if (!stored) {
    stored = toHex(crypto.getRandomValues(new Uint8Array(32)));
    await setSetting(env.DB, 'internal_session_secret', stored);
  }
  return getSigningSecret(env, stored);
}

export async function issueAdminToken(env: Env): Promise<string> {
  const secret = await ensureSigningSecret(env);
  const exp = Date.now() + 1000 * 60 * 60 * 12; // 12 hours
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const payload = `admin.${exp}.${nonce}`;
  const sig = await hmacSha256Hex(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyAdminRequest(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'admin') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;

  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const secret = await ensureSigningSecret(env);
  const expectedSig = await hmacSha256Hex(secret, payload);
  return constantTimeEqual(parts[3], expectedSig);
}

export async function getEffectiveBotToken(env: Env): Promise<string> {
  const dbToken = await getSetting(env.DB, 'bot_token');
  if (dbToken && dbToken.trim()) return dbToken.trim();
  return (env.TELEGRAM_BOT_TOKEN || '').trim();
}

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 10) return '••••••••';
  return `${value.slice(0, 6)}••••••${value.slice(-4)}`;
}

/**
 * Verifies Telegram WebApp initData HMAC-SHA256 using the Bot Token.
 * Returns parsed telegram user ID & username if valid, or null if invalid.
 */
export async function verifyTelegramInitData(
  initData: string,
  botToken: string
): Promise<{ telegramId: string; username: string } | null> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      pairs.push(`${key}=${value}`);
    }
  });
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const webAppKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const secretKeyBytes = await crypto.subtle.sign('HMAC', webAppKey, encoder.encode(botToken));

  const dataKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const computedSig = await crypto.subtle.sign('HMAC', dataKey, encoder.encode(dataCheckString));
  if (!constantTimeEqual(toHex(computedSig), hash)) {
    return null;
  }

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try {
    const parsed = JSON.parse(userRaw) as { id?: number | string; username?: string };
    if (!parsed.id) return null;
    return {
      telegramId: String(parsed.id),
      username: typeof parsed.username === 'string' ? parsed.username : '',
    };
  } catch {
    return null;
  }
}

export async function upsertUserActivity(
  db: D1Database,
  telegramId: string,
  username: string,
  incrementVideos = 0
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (telegram_id, username, videos_created, created_at, last_active_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(telegram_id) DO UPDATE SET
         username = CASE WHEN excluded.username != '' THEN excluded.username ELSE users.username END,
         videos_created = users.videos_created + ?,
         last_active_at = datetime('now')`
    )
    .bind(telegramId, username, incrementVideos, incrementVideos)
    .run();
}
