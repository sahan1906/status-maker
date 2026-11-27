import { jsonResponse } from '../_lib/security';
import { D1Database, PagesHandler } from '../_lib/types';

export interface OverlayTemplateRow {
  id: string;
  name: string;
  tagline: string;
  badge: string;
  video_url: string;
  telegram_file_id: string;
  fit_mode: string;
  chroma_sensitivity: number;
  accent_color: string;
  default_title: string;
  created_at: string;
}

export async function ensureOverlayTemplatesTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS overlay_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL DEFAULT '',
        badge TEXT NOT NULL DEFAULT 'AI Overlay',
        video_url TEXT NOT NULL DEFAULT '',
        telegram_file_id TEXT NOT NULL DEFAULT '',
        fit_mode TEXT NOT NULL DEFAULT 'full-frame',
        chroma_sensitivity REAL NOT NULL DEFAULT 0.55,
        accent_color TEXT NOT NULL DEFAULT '#F472B6',
        default_title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    )
    .run();
}

export const onRequestGet: PagesHandler = async ({ env }) => {
  try {
    await ensureOverlayTemplatesTable(env.DB);
    const { results } = await env.DB.prepare(
      `SELECT id, name, tagline, badge, fit_mode, chroma_sensitivity, accent_color, default_title, created_at
       FROM overlay_templates
       ORDER BY created_at DESC`
    ).all<OverlayTemplateRow>();

    const overlays = results.map((row) => ({
      id: row.id,
      name: row.name,
      tagline: row.tagline || 'Premade green-screen overlay — drop your photo or video behind it',
      badge: row.badge || 'AI Overlay',
      fit_mode: row.fit_mode === 'detected-rect' ? 'detected-rect' : 'full-frame',
      chroma_sensitivity:
        Number.isFinite(Number(row.chroma_sensitivity))
          ? Math.max(0.15, Math.min(0.95, Number(row.chroma_sensitivity)))
          : 0.55,
      accent_color: row.accent_color || '#F472B6',
      default_title: row.default_title || '',
      stream_url: `/api/overlay-media?id=${encodeURIComponent(row.id)}`,
      created_at: row.created_at,
    }));

    return jsonResponse({ ok: true, overlays });
  } catch {
    return jsonResponse({ ok: true, overlays: [] });
  }
};
