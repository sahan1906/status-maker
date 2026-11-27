import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

// In-memory local preview mirror of Cloudflare D1 tables (users & app_settings).
// In production on Cloudflare Pages, /functions/api/* connects directly to Cloudflare D1 (env.DB).
interface LocalUser {
  telegram_id: string;
  username: string;
  videos_created: number;
  created_at: string;
  last_active_at: string;
}

const usersMap = new Map<string, LocalUser>();
const settingsMap = new Map<string, string>([
  ['site_name', 'ReelCraft'],
  ['watermark_text', 'ReelCraft'],
  ['watermark_enabled', 'true'],
  ['reward_ad_enabled', 'false'],
  ['ad_provider', 'adsgram'],
  ['adsgram_block_id', ''],
  ['monetag_zone_id', ''],
  ['richads_pub_id', ''],
  ['gigapub_id', ''],
  ['cleanads_rewarded_enabled', 'false'],
  ['cleanads_rewarded_placement_id', ''],
  ['cleanads_interstitial_enabled', 'false'],
  ['cleanads_interstitial_placement_id', ''],
  ['cleanads_test_mode', 'false'],
  ['shorts_ad_enabled', 'true'],
  ['shorts_ad_every_n', '5'],
  ['shorts_download_ad_enabled', 'true'],
  ['shorts_api_base_url', 'https://pulse-shorts.pages.dev'],
  ['telegram_bot_username', ''],
  ['telegram_miniapp_short_name', ''],
]);

const shortsLikesMap = new Map<string, number>();

const RUNTIME_SESSION_SECRET =
  (process.env.SESSION_SECRET || '').trim() ||
  crypto.randomBytes(32).toString('hex');

const PUBLIC_KEYS = [
  'site_name',
  'watermark_text',
  'watermark_enabled',
  'reward_ad_enabled',
  'ad_provider',
  'adsgram_block_id',
  'monetag_zone_id',
  'richads_pub_id',
  'gigapub_id',
  'cleanads_rewarded_enabled',
  'cleanads_rewarded_placement_id',
  'cleanads_interstitial_enabled',
  'cleanads_interstitial_placement_id',
  'cleanads_test_mode',
  'shorts_ad_enabled',
  'shorts_ad_every_n',
  'shorts_download_ad_enabled',
  'shorts_api_base_url',
  'telegram_bot_username',
  'telegram_miniapp_short_name',
] as const;

const BOOLEAN_KEYS = new Set<string>([
  'watermark_enabled',
  'reward_ad_enabled',
  'cleanads_rewarded_enabled',
  'cleanads_interstitial_enabled',
  'cleanads_test_mode',
  'shorts_ad_enabled',
  'shorts_download_ad_enabled',
]);

function extractCleanAdsPlacementId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const plMatch = trimmed.match(/\b(pl_[a-zA-Z0-9_-]+)\b/);
  if (plMatch?.[1]) return plMatch[1].slice(0, 120);
  const propMatch = trimmed.match(/placementId\s*[:=]\s*['"`]([^'"`\s]+)['"`]/i);
  if (propMatch?.[1]) return propMatch[1].trim().slice(0, 120);
  return trimmed.slice(0, 120);
}

const ALLOWED_PROVIDERS = new Set(['adsgram', 'monetag', 'richads', 'gigapub']);

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function hashPasswordNode(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPasswordNode(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const derived = crypto.scryptSync(password, parts[1], 32).toString('hex');
  return timingSafeEqualStr(derived, parts[2]);
}

function issueToken(): string {
  const exp = Date.now() + 1000 * 60 * 60 * 12;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `admin.${exp}.${nonce}`;
  const sig = crypto
    .createHmac('sha256', RUNTIME_SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(authHeader?: string): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'admin') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = crypto
    .createHmac('sha256', RUNTIME_SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return timingSafeEqualStr(parts[3], expected);
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!verifyToken(req.headers.authorization)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function getEffectiveBotToken(): string {
  const dbVal = (settingsMap.get('bot_token') || '').trim();
  return dbVal || (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function maskSecret(val: string): string {
  if (!val) return '';
  if (val.length <= 10) return '••••••••';
  return `${val.slice(0, 6)}••••••${val.slice(-4)}`;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Public non-secret config
  app.get('/api/config', (_req, res) => {
    const out: Record<string, string | boolean | number> = {};
    for (const key of PUBLIC_KEYS) {
      const val = settingsMap.get(key) ?? '';
      if (BOOLEAN_KEYS.has(key)) {
        out[key] = val === 'true';
      } else if (key === 'shorts_ad_every_n') {
        const parsed = Number.parseInt(val || '5', 10);
        out[key] = Number.isFinite(parsed) ? Math.max(3, Math.min(10, parsed)) : 5;
      } else {
        out[key] = val;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(out);
  });

  // Admin auth status + bootstrap + login
  app.get('/api/admin/auth', (_req, res) => {
    const envPassword = (process.env.ADMIN_PASSWORD || '').trim();
    if (envPassword) {
      res.json({ needsSetup: false, envControlled: true });
      return;
    }
    const storedHash = settingsMap.get('admin_password_hash');
    res.json({ needsSetup: !storedHash, envControlled: false });
  });

  app.post('/api/admin/auth', (req, res) => {
    const action = req.body?.action === 'bootstrap' ? 'bootstrap' : 'login';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const envPassword = (process.env.ADMIN_PASSWORD || '').trim();

    if (action === 'bootstrap') {
      if (envPassword) {
        res.status(403).json({ error: 'Admin password is managed by ADMIN_PASSWORD secret.' });
        return;
      }
      if (settingsMap.get('admin_password_hash')) {
        res.status(403).json({ error: 'Admin setup is already complete.' });
        return;
      }
      if (password.trim().length < 8) {
        res.status(400).json({ error: 'Choose an admin password of at least 8 characters.' });
        return;
      }
      settingsMap.set('admin_password_hash', hashPasswordNode(password));
      res.json({ ok: true, token: issueToken() });
      return;
    }

    if (!password) {
      res.status(400).json({ error: 'Password is required.' });
      return;
    }

    let valid = false;
    if (envPassword) {
      valid = timingSafeEqualStr(password, envPassword);
    } else {
      const storedHash = settingsMap.get('admin_password_hash');
      if (!storedHash) {
        res.status(403).json({ error: 'Admin password has not been set up yet.' });
        return;
      }
      valid = verifyPasswordNode(password, storedHash);
    }

    if (!valid) {
      res.status(401).json({ error: 'Invalid admin password.' });
      return;
    }

    res.json({ ok: true, token: issueToken() });
  });

  // Protected Admin Stats
  app.get('/api/admin/stats', requireAdmin, (_req, res) => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let totalVideos = 0;
    let activeToday = 0;
    for (const u of usersMap.values()) {
      totalVideos += u.videos_created;
      if (now - Date.parse(u.last_active_at) <= dayMs) {
        activeToday += 1;
      }
    }
    res.json({
      totalUsers: usersMap.size,
      totalVideos,
      activeToday,
    });
  });

  // Protected Admin Settings
  app.get('/api/admin/settings', requireAdmin, (_req, res) => {
    const token = getEffectiveBotToken();
    res.json({
      site_name: settingsMap.get('site_name') || 'ReelCraft',
      watermark_text: settingsMap.get('watermark_text') || 'ReelCraft',
      watermark_enabled: settingsMap.get('watermark_enabled') === 'true',
      reward_ad_enabled: settingsMap.get('reward_ad_enabled') === 'true',
      ad_provider: settingsMap.get('ad_provider') || 'adsgram',
      adsgram_block_id: settingsMap.get('adsgram_block_id') || '',
      monetag_zone_id: settingsMap.get('monetag_zone_id') || '',
      richads_pub_id: settingsMap.get('richads_pub_id') || '',
      gigapub_id: settingsMap.get('gigapub_id') || '',
      cleanads_rewarded_enabled: settingsMap.get('cleanads_rewarded_enabled') === 'true',
      cleanads_rewarded_placement_id: settingsMap.get('cleanads_rewarded_placement_id') || '',
      cleanads_interstitial_enabled: settingsMap.get('cleanads_interstitial_enabled') === 'true',
      cleanads_interstitial_placement_id: settingsMap.get('cleanads_interstitial_placement_id') || '',
      cleanads_test_mode: settingsMap.get('cleanads_test_mode') === 'true',
      shorts_ad_enabled: (settingsMap.get('shorts_ad_enabled') ?? 'true') === 'true',
      shorts_ad_every_n: Math.max(
        3,
        Math.min(10, Number.parseInt(settingsMap.get('shorts_ad_every_n') || '5', 10) || 5)
      ),
      shorts_download_ad_enabled: (settingsMap.get('shorts_download_ad_enabled') ?? 'true') === 'true',
      shorts_api_base_url: settingsMap.get('shorts_api_base_url') || 'https://pulse-shorts.pages.dev',
      telegram_bot_username: settingsMap.get('telegram_bot_username') || '',
      telegram_miniapp_short_name: settingsMap.get('telegram_miniapp_short_name') || '',
      bot_token_configured: Boolean(token),
      bot_token_masked: maskSecret(token),
    });
  });

  app.post('/api/admin/settings', requireAdmin, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const keys = [...PUBLIC_KEYS, 'bot_token'] as const;
    for (const key of keys) {
      if (!(key in body)) continue;
      const raw = body[key];
      if (key === 'bot_token') {
        if (typeof raw === 'string' && raw.trim()) {
          settingsMap.set('bot_token', raw.trim().slice(0, 120));
        }
        continue;
      }
      if (BOOLEAN_KEYS.has(key)) {
        settingsMap.set(key, raw === true || raw === 'true' ? 'true' : 'false');
        continue;
      }
      if (key === 'shorts_ad_every_n') {
        const n = Number.parseInt(String(raw ?? '5'), 10);
        settingsMap.set(key, String(Number.isFinite(n) ? Math.max(3, Math.min(10, n)) : 5));
        continue;
      }
      if (key === 'ad_provider') {
        settingsMap.set(
          key,
          typeof raw === 'string' && ALLOWED_PROVIDERS.has(raw) ? raw : 'adsgram'
        );
        continue;
      }
      if (
        (key === 'cleanads_rewarded_placement_id' || key === 'cleanads_interstitial_placement_id') &&
        typeof raw === 'string'
      ) {
        settingsMap.set(key, extractCleanAdsPlacementId(raw));
        continue;
      }
      if (typeof raw === 'string') {
        settingsMap.set(key, raw.trim().slice(0, 120));
      }
    }
    res.json({ ok: true });
  });

  // Protected Admin Webhook registration
  app.post('/api/admin/webhook', requireAdmin, async (req, res) => {
    const botToken = getEffectiveBotToken();
    if (!botToken) {
      res.status(400).json({ error: 'Save a Telegram Bot Token first.' });
      return;
    }
    const rawBase = (process.env.APP_URL || `https://${req.headers.host || ''}`).trim();
    let parsedOrigin = '';
    try {
      const parsed = new URL(rawBase);
      if (parsed.protocol === 'https:') {
        parsedOrigin = parsed.origin;
      }
    } catch {
      parsedOrigin = '';
    }
    if (!parsedOrigin) {
      res.status(400).json({ error: 'Webhook requires a valid HTTPS domain (Cloudflare Pages URL).' });
      return;
    }
    const webhookUrl = `${parsedOrigin}/api/telegram/webhook`;
    const payload: Record<string, string> = { url: webhookUrl };
    if (process.env.TELEGRAM_WEBHOOK_SECRET?.trim()) {
      payload.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET.trim();
    }
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const tgData = (await tgRes.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!tgRes.ok || !tgData.ok) {
        res.status(502).json({ error: tgData.description || 'Telegram rejected webhook setup.' });
        return;
      }
      res.json({ ok: true, webhookUrl, description: tgData.description || 'Webhook registered.' });
    } catch {
      res.status(502).json({ error: 'Could not reach Telegram Bot API.' });
    }
  });

  // Protected Batched Broadcast (25 per batch)
  app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
    const botToken = getEffectiveBotToken();
    if (!botToken) {
      res.status(400).json({ error: 'Configure your Telegram Bot Token before broadcasting.' });
      return;
    }
    const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 1000) : '';
    const offset =
      typeof req.body?.offset === 'number' && Number.isFinite(req.body.offset) && req.body.offset >= 0
        ? Math.floor(req.body.offset)
        : 0;
    if (!message) {
      res.status(400).json({ error: 'Broadcast message cannot be empty.' });
      return;
    }
    const allUsers = Array.from(usersMap.values());
    const batch = allUsers.slice(offset, offset + 25);
    let sent = 0;
    let failed = 0;
    await Promise.all(
      batch.map(async (u) => {
        try {
          const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: u.telegram_id, text: message }),
          });
          const data = (await tgRes.json().catch(() => ({}))) as { ok?: boolean };
          if (tgRes.ok && data.ok) sent += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      })
    );
    const nextOffset = offset + batch.length;
    const done = batch.length < 25 || nextOffset >= allUsers.length;
    res.json({ ok: true, sent, failed, processed: batch.length, total: allUsers.length, nextOffset, done });
  });

  // Preview endpoint for send-video when running outside Cloudflare Pages
  app.post('/api/send-video', (_req, res) => {
    const botToken = getEffectiveBotToken();
    if (!botToken) {
      res.status(503).json({
        error: 'Telegram Bot Token is not configured yet. Use Save / Share below, or configure your bot in /admin.',
      });
      return;
    }
    res.status(401).json({
      error: 'Open ReelCraft inside Telegram to send videos directly to your Telegram chat.',
    });
  });

  // Live Pulse Shorts proxy (/api/reels) for zero-CORS streaming
  app.get('/api/reels', async (req, res) => {
    const rawLimit = Number.parseInt(String(req.query.limit || '20'), 10);
    const rawOffset = Number.parseInt(String(req.query.offset || '0'), 10);
    const rawSeed = String(req.query.seed || '').trim();
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
    const seed = /^[a-zA-Z0-9_-]{1,32}$/.test(rawSeed)
      ? rawSeed
      : String(Math.floor(Math.random() * 1_000_000));

    const configuredBase = (settingsMap.get('shorts_api_base_url') || 'https://pulse-shorts.pages.dev')
      .trim()
      .replace(/\/+$/, '');
    let baseUrl = 'https://pulse-shorts.pages.dev';
    try {
      const parsed = new URL(configuredBase);
      if (parsed.protocol === 'https:') baseUrl = parsed.origin;
    } catch {
      // Keep default
    }

    const resolveUrl = (raw?: unknown) => {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (!s) return '';
      if (s.startsWith('https://') || s.startsWith('http://')) return s;
      return s.startsWith('/') ? `${baseUrl}${s}` : `${baseUrl}/${s}`;
    };

    try {
      const upstream = await fetch(
        `${baseUrl}/api/videos?limit=${limit}&offset=${offset}&seed=${encodeURIComponent(seed)}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!upstream.ok) {
        res.status(502).json({ error: `Pulse Shorts returned HTTP ${upstream.status}.`, videos: [], total: 0, has_more: false });
        return;
      }
      const data = (await upstream.json()) as {
        videos?: Array<Record<string, unknown>>;
        total?: number;
        has_more?: boolean;
      };
      const rawVideos = Array.isArray(data.videos) ? data.videos : [];
      const videos = rawVideos
        .map((item) => {
          const id = typeof item.id === 'string' ? item.id.trim() : '';
          const video_url = resolveUrl(item.video_url);
          if (!id || !video_url) return null;
          const tags = typeof item.tags === 'string' ? item.tags.trim() : '';
          const tag_list = tags
            ? tags
                .split(',')
                .map((t) => t.trim().replace(/^#+/, ''))
                .filter(Boolean)
                .slice(0, 6)
            : [];
          return {
            id,
            title: (typeof item.title === 'string' && item.title.trim()) || 'AI Edit Short',
            video_url,
            poster_url: resolveUrl(item.poster_url),
            tags,
            tag_list,
            likes: Math.max(0, Number(item.likes) || 0) + (shortsLikesMap.get(id) || 0),
            comments_count: Math.max(0, Number(item.comments_count) || 0),
            created_at: typeof item.created_at === 'string' ? item.created_at : '',
          };
        })
        .filter(Boolean);

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        videos,
        total: typeof data.total === 'number' ? data.total : videos.length,
        has_more: Boolean(data.has_more),
        offset,
        limit,
        seed,
      });
    } catch {
      res.status(502).json({ error: 'Could not reach Pulse Shorts upstream.', videos: [], total: 0, has_more: false });
    }
  });

  app.post('/api/reels-like', (req, res) => {
    const videoId = typeof req.body?.video_id === 'string' ? req.body.video_id.trim() : '';
    const action = req.body?.action === 'unlike' ? 'unlike' : 'like';
    if (!videoId || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(videoId)) {
      res.status(400).json({ error: 'Invalid video ID.' });
      return;
    }
    const cur = shortsLikesMap.get(videoId) || 0;
    const next = action === 'like' ? cur + 1 : Math.max(0, cur - 1);
    shortsLikesMap.set(videoId, next);
    res.json({ ok: true, video_id: videoId, delta_likes: next });
  });

  app.get('/api/reels-download', async (req, res) => {
    const rawTarget = String(req.query.url || '').trim();
    const rawTitle = String(req.query.title || 'pulse-short').trim();
    if (!rawTarget) {
      res.status(400).json({ error: 'Missing video URL.' });
      return;
    }
    let targetUrl: URL;
    try {
      targetUrl = new URL(rawTarget);
    } catch {
      res.status(400).json({ error: 'Invalid video URL.' });
      return;
    }
    const host = targetUrl.hostname.toLowerCase();
    if (
      targetUrl.protocol !== 'https:' ||
      host === 'localhost' ||
      /^127\.|^10\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      res.status(403).json({ error: 'Disallowed host.' });
      return;
    }
    try {
      const upstream = await fetch(targetUrl.toString());
      if (!upstream.ok || !upstream.body) {
        res.status(502).json({ error: 'Upstream video unavailable.' });
        return;
      }
      const slug = rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
      res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${slug || 'pulse-short'}.mp4"`);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch {
      res.status(502).json({ error: 'Could not download video.' });
    }
  });

  // Vite dev middleware or static dist serving
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output missing');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReelCraft server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
