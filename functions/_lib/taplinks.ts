import { constantTimeEqual, getAllSettingsMap } from './security';
import { D1Database } from './types';

export interface TapLinkRow {
  id: string;
  code: string;
  destination_url: string;
  title: string;
  creator_type: string;
  creator_ref: string;
  creator_label: string;
  clicks: number;
  unlocks: number;
  created_at: number;
}

export interface TapLinkApiKeyRow {
  id: string;
  name: string;
  contact_note: string;
  key_prefix: string;
  key_hash: string;
  status: 'active' | 'revoked';
  daily_limit: number;
  links_created: number;
  last_used_at: number | null;
  created_at: number;
}

const RESERVED_ALIASES = new Set([
  'admin',
  'api',
  'edits',
  'shorts',
  'taplinks',
  'templates',
  'editor',
  'l',
  'v1',
]);

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export async function ensureTapLinksTables(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS taplinks (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        destination_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        creator_type TEXT NOT NULL DEFAULT 'app',
        creator_ref TEXT NOT NULL DEFAULT '',
        creator_label TEXT NOT NULL DEFAULT 'Mini App',
        clicks INTEGER NOT NULL DEFAULT 0,
        unlocks INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS taplink_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        contact_note TEXT NOT NULL DEFAULT '',
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        daily_limit INTEGER NOT NULL DEFAULT 500,
        links_created INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL
      )`
    )
    .run();
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}

export function generateShortCode(length = 7): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function generateDeveloperApiKey(): {
  plainKey: string;
  keyPrefix: string;
} {
  const rawBytes = crypto.getRandomValues(new Uint8Array(24));
  const plainKey = `tl_live_${toHex(rawBytes)}`;
  const keyPrefix = `${plainKey.slice(0, 14)}••••${plainKey.slice(-4)}`;
  return { plainKey, keyPrefix };
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().trim();
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '::1'
  ) {
    return true;
  }
  // Block RFC1918, loopback, and cloud metadata IPv4 ranges
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

export function validateDestinationUrl(
  rawInput: unknown,
  currentOrigin?: string
): { ok: true; url: string; host: string } | { ok: false; error: string } {
  if (typeof rawInput !== 'string') {
    return { ok: false, error: 'Destination URL is required.' };
  }
  let candidate = rawInput.trim();
  if (!candidate) {
    return { ok: false, error: 'Destination URL cannot be empty.' };
  }
  if (candidate.length > 2048) {
    return { ok: false, error: 'Destination URL is too long (max 2048 characters).' };
  }

  // Allow convenient t.me/... or domain.com/... input without scheme
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'Enter a valid http:// or https:// destination URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Only http:// and https:// URLs are allowed.' };
  }

  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, error: 'Local or private network URLs cannot be shortened.' };
  }

  if (!parsed.hostname.includes('.')) {
    return { ok: false, error: 'Enter a valid public domain name.' };
  }

  // Prevent infinite self-redirect loops to our own /l/ endpoint
  if (currentOrigin) {
    try {
      const originUrl = new URL(currentOrigin);
      if (parsed.origin === originUrl.origin && parsed.pathname.startsWith('/l/')) {
        return { ok: false, error: 'Cannot shorten an existing TapLink URL.' };
      }
    } catch {
      // Ignore malformed origin header
    }
  }

  return {
    ok: true,
    url: parsed.toString(),
    host: parsed.hostname.replace(/^www\./, ''),
  };
}

export function sanitizeAlias(raw: unknown): { ok: true; alias: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, alias: '' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Custom alias must be text.' };
  }
  const clean = raw.trim().toLowerCase();
  if (!clean) return { ok: true, alias: '' };
  if (!/^[a-z0-9_-]{3,32}$/.test(clean)) {
    return {
      ok: false,
      error: 'Custom alias must be 3–32 letters, numbers, hyphens, or underscores.',
    };
  }
  if (RESERVED_ALIASES.has(clean)) {
    return { ok: false, error: `"${clean}" is a reserved word. Choose another alias.` };
  }
  return { ok: true, alias: clean };
}

export function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 90);
}

export async function getTapLinkBaseConfig(db: D1Database): Promise<{
  botUsername: string;
  miniAppShortName: string;
  siteName: string;
}> {
  const map = await getAllSettingsMap(db);
  return {
    botUsername: (map.telegram_bot_username || '').replace(/^@+/, '').trim(),
    miniAppShortName: (map.telegram_miniapp_short_name || '').trim(),
    siteName: map.site_name || 'ReelCraft',
  };
}

export function buildTapLinkUrls(
  code: string,
  origin: string,
  botUsername: string,
  miniAppShortName: string
): { short_url: string; telegram_url: string; web_url: string } {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const webUrl = `${cleanOrigin}/l/${encodeURIComponent(code)}`;
  const startParam = `tl_${code}`;

  let telegramUrl = '';
  if (botUsername) {
    telegramUrl = miniAppShortName
      ? `https://t.me/${botUsername}/${miniAppShortName}?startapp=${encodeURIComponent(startParam)}`
      : `https://t.me/${botUsername}?startapp=${encodeURIComponent(startParam)}`;
  }

  return {
    short_url: telegramUrl || webUrl,
    telegram_url: telegramUrl,
    web_url: webUrl,
  };
}

export function extractDestinationHost(destUrl: string): string {
  try {
    const parsed = new URL(destUrl);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export async function createTapLinkRecord(params: {
  db: D1Database;
  destinationUrl: string;
  title: string;
  alias?: string;
  creatorType: 'app' | 'api';
  creatorRef: string;
  creatorLabel: string;
}): Promise<{ ok: true; row: TapLinkRow } | { ok: false; error: string; status: number }> {
  await ensureTapLinksTables(params.db);

  let code = params.alias || '';
  if (code) {
    const existing = await params.db
      .prepare('SELECT id FROM taplinks WHERE code = ?')
      .bind(code)
      .first<{ id: string }>();
    if (existing) {
      return {
        ok: false,
        error: `Alias "${code}" is already taken. Try a different alias.`,
        status: 409,
      };
    }
  } else {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const candidate = generateShortCode(7);
      const existing = await params.db
        .prepare('SELECT id FROM taplinks WHERE code = ?')
        .bind(candidate)
        .first<{ id: string }>();
      if (!existing) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      return { ok: false, error: 'Could not allocate short code. Please retry.', status: 500 };
    }
  }

  const id = `tl_${Date.now().toString(36)}_${generateShortCode(6)}`;
  const createdAt = Date.now();

  await params.db
    .prepare(
      `INSERT INTO taplinks (id, code, destination_url, title, creator_type, creator_ref, creator_label, clicks, unlocks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
    )
    .bind(
      id,
      code,
      params.destinationUrl,
      params.title,
      params.creatorType,
      params.creatorRef,
      params.creatorLabel,
      createdAt
    )
    .run();

  return {
    ok: true,
    row: {
      id,
      code,
      destination_url: params.destinationUrl,
      title: params.title,
      creator_type: params.creatorType,
      creator_ref: params.creatorRef,
      creator_label: params.creatorLabel,
      clicks: 0,
      unlocks: 0,
      created_at: createdAt,
    },
  };
}

export async function verifyDeveloperApiKeyRequest(
  request: Request,
  db: D1Database,
  options?: { enforceQuota?: boolean }
): Promise<
  | { ok: true; keyRow: TapLinkApiKeyRow }
  | { ok: false; error: string; status: number }
> {
  await ensureTapLinksTables(db);

  const authHeader = request.headers.get('Authorization') || '';
  const xApiKey = request.headers.get('X-API-Key') || '';
  const rawKey = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : xApiKey.trim();

  if (!rawKey || !rawKey.startsWith('tl_live_') || rawKey.length < 24) {
    return {
      ok: false,
      error: 'Missing or invalid TapLinks API key. Send Authorization: Bearer tl_live_... or X-API-Key header.',
      status: 401,
    };
  }

  const hash = await sha256Hex(rawKey);
  const row = await db
    .prepare(
      `SELECT id, name, contact_note, key_prefix, key_hash, status, daily_limit, links_created, last_used_at, created_at
       FROM taplink_api_keys
       WHERE key_hash = ?`
    )
    .bind(hash)
    .first<TapLinkApiKeyRow>();

  if (!row || !constantTimeEqual(row.key_hash, hash)) {
    return { ok: false, error: 'Invalid API key.', status: 401 };
  }

  if (row.status !== 'active') {
    return {
      ok: false,
      error: 'This API key has been suspended or revoked by the administrator.',
      status: 403,
    };
  }

  // Enforce daily creation quota safely using created_at >= 24h ago
  if (options?.enforceQuota !== false) {
    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const usedRow = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM taplinks WHERE creator_type = 'api' AND creator_ref = ? AND created_at >= ?`
      )
      .bind(row.id, dayStart)
      .first<{ cnt: number }>();

    const used24h = Number(usedRow?.cnt) || 0;
    if (row.daily_limit > 0 && used24h >= row.daily_limit) {
      return {
        ok: false,
        error: `Daily quota reached (${row.daily_limit} links / 24h). Contact admin to raise your limit.`,
        status: 429,
      };
    }
  }

  return { ok: true, keyRow: row };
}

export function devApiJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
    },
  });
}

export function devApiCorsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
      'Access-Control-Max-Age': '86400',
    },
  });
}
