import { jsonResponse } from '../_lib/security';
import { D1Database, PagesHandler } from '../_lib/types';

export interface ShortsVideoRow {
  id: string;
  title: string;
  tags: string;
  telegram_file_id: string;
  poster_file_id: string;
  telegram_message_id: number | null;
  likes: number;
  created_at: number;
}

export async function ensureShortsVideosTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS shorts_videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        telegram_file_id TEXT NOT NULL,
        poster_file_id TEXT NOT NULL DEFAULT '',
        telegram_message_id INTEGER,
        likes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`
    )
    .run();
}

export function parseTagsList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim().replace(/^#+/, ''))
    .filter(Boolean)
    .slice(0, 6);
}

export function formatShortVideoRow(row: ShortsVideoRow) {
  const tags = (row.tags || '').trim();
  return {
    id: row.id,
    title: row.title || 'Short Reel',
    video_url: `/api/shorts-stream?id=${encodeURIComponent(row.id)}&kind=video`,
    poster_url: row.poster_file_id
      ? `/api/shorts-stream?id=${encodeURIComponent(row.id)}&kind=poster`
      : '',
    tags,
    tag_list: parseTagsList(tags),
    likes: Math.max(0, Number(row.likes) || 0),
    comments_count: 0,
    created_at: new Date(Number(row.created_at) || Date.now()).toISOString(),
  };
}

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get('limit') || '12', 10);
  const rawOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 12;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

  try {
    await ensureShortsVideosTable(env.DB);

    const [countRow, listRes] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) as total FROM shorts_videos`).first<{ total: number }>(),
      env.DB.prepare(
        `SELECT id, title, tags, telegram_file_id, poster_file_id, telegram_message_id, likes, created_at
         FROM shorts_videos
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
        .bind(limit, offset)
        .all<ShortsVideoRow>(),
    ]);

    const total = Number(countRow?.total) || 0;
    const rows = listRes.results || [];
    const videos = rows.map(formatShortVideoRow);

    return jsonResponse({
      videos,
      total,
      has_more: offset + videos.length < total,
      offset,
      limit,
    });
  } catch {
    return jsonResponse({
      videos: [],
      total: 0,
      has_more: false,
      offset,
      limit,
    });
  }
};
