import { getSetting, jsonResponse } from '../_lib/security';
import { D1Database, PagesHandler } from '../_lib/types';

export const DEFAULT_PULSE_SHORTS_BASE = 'https://pulse-shorts.pages.dev';

export interface UpstreamReelVideo {
  id: string;
  title?: string;
  video_url: string;
  poster_url?: string;
  tags?: string;
  likes?: number;
  comments_count?: number;
  created_at?: string;
}

export interface NormalizedReelVideo {
  id: string;
  title: string;
  video_url: string;
  poster_url: string;
  tags: string;
  tag_list: string[];
  likes: number;
  comments_count: number;
  created_at: string;
}

export async function ensureShortsLikesTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS shorts_likes (
        video_id TEXT PRIMARY KEY,
        delta_likes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`
    )
    .run();
}

export async function getPulseShortsBaseUrl(db: D1Database): Promise<string> {
  try {
    const raw = (await getSetting(db, 'shorts_api_base_url')) || '';
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (trimmed) {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:') {
        return parsed.origin;
      }
    }
  } catch {
    // Fallback to default
  }
  return DEFAULT_PULSE_SHORTS_BASE;
}

function resolveMediaUrl(rawUrl: unknown, baseUrl: string): string {
  const s = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!s) return '';
  if (s.startsWith('https://') || s.startsWith('http://')) {
    return s;
  }
  if (s.startsWith('/')) {
    return `${baseUrl}${s}`;
  }
  return `${baseUrl}/${s}`;
}

function parseTags(rawTags: unknown): { tags: string; tag_list: string[] } {
  const str = typeof rawTags === 'string' ? rawTags.trim() : '';
  if (!str) return { tags: '', tag_list: [] };
  const list = str
    .split(',')
    .map((t) => t.trim().replace(/^#+/, ''))
    .filter((t) => t.length > 0)
    .slice(0, 6);
  return { tags: str, tag_list: list };
}

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
  const rawOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
  const rawSeed = (url.searchParams.get('seed') || '').trim();

  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
  const seed = /^[a-zA-Z0-9_-]{1,32}$/.test(rawSeed)
    ? rawSeed
    : String(Math.floor(Math.random() * 1_000_000));

  const baseUrl = await getPulseShortsBaseUrl(env.DB);
  const upstreamUrl = `${baseUrl}/api/videos?limit=${limit}&offset=${offset}&seed=${encodeURIComponent(seed)}`;

  let upstreamData: {
    videos?: UpstreamReelVideo[];
    total?: number;
    has_more?: boolean;
  };

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ReelCraft-ShortsProxy/1.0',
      },
    });

    if (!upstreamRes.ok) {
      return jsonResponse(
        {
          error: `Pulse Shorts upstream returned HTTP ${upstreamRes.status}.`,
          videos: [],
          total: 0,
          has_more: false,
        },
        502
      );
    }

    upstreamData = (await upstreamRes.json()) as {
      videos?: UpstreamReelVideo[];
      total?: number;
      has_more?: boolean;
    };
  } catch {
    return jsonResponse(
      {
        error: 'Could not reach Pulse Shorts feed upstream.',
        videos: [],
        total: 0,
        has_more: false,
      },
      502
    );
  }

  const rawVideos = Array.isArray(upstreamData.videos) ? upstreamData.videos : [];

  // Load any locally persisted ReelCraft likes deltas for this page of video IDs
  const likesDeltaMap = new Map<string, number>();
  const videoIds = rawVideos
    .map((v) => (typeof v?.id === 'string' ? v.id.trim() : ''))
    .filter((id) => id.length > 0 && id.length <= 128);

  if (videoIds.length > 0 && env.DB) {
    try {
      await ensureShortsLikesTable(env.DB);
      const placeholders = videoIds.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT video_id, delta_likes FROM shorts_likes WHERE video_id IN (${placeholders})`
      )
        .bind(...videoIds)
        .all<{ video_id: string; delta_likes: number }>();

      for (const row of rows.results || []) {
        likesDeltaMap.set(row.video_id, Number(row.delta_likes) || 0);
      }
    } catch {
      // Non-fatal: still return upstream videos
    }
  }

  const videos: NormalizedReelVideo[] = [];
  for (const item of rawVideos) {
    if (!item || typeof item.id !== 'string' || !item.id.trim()) continue;
    const videoUrl = resolveMediaUrl(item.video_url, baseUrl);
    if (!videoUrl) continue;

    const id = item.id.trim();
    const posterUrl = resolveMediaUrl(item.poster_url, baseUrl);
    const { tags, tag_list } = parseTags(item.tags);
    const baseLikes = Math.max(0, Number(item.likes) || 0);
    const deltaLikes = Math.max(0, likesDeltaMap.get(id) || 0);

    videos.push({
      id,
      title: (typeof item.title === 'string' && item.title.trim()) || 'AI Edit Short',
      video_url: videoUrl,
      poster_url: posterUrl,
      tags,
      tag_list,
      likes: baseLikes + deltaLikes,
      comments_count: Math.max(0, Number(item.comments_count) || 0),
      created_at: typeof item.created_at === 'string' ? item.created_at : '',
    });
  }

  return jsonResponse({
    videos,
    total: typeof upstreamData.total === 'number' ? upstreamData.total : videos.length,
    has_more: Boolean(upstreamData.has_more),
    offset,
    limit,
    seed,
  });
};
