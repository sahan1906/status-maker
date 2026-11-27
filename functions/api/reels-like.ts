import { jsonResponse } from '../_lib/security';
import { PagesHandler } from '../_lib/types';
import { ensureShortsLikesTable } from './reels';

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  let body: { video_id?: unknown; action?: unknown };
  try {
    body = (await request.json()) as { video_id?: unknown; action?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload.' }, 400);
  }

  const videoId = typeof body.video_id === 'string' ? body.video_id.trim() : '';
  const action = body.action === 'unlike' ? 'unlike' : 'like';

  if (!videoId || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(videoId)) {
    return jsonResponse({ error: 'Invalid video ID.' }, 400);
  }

  try {
    await ensureShortsLikesTable(env.DB);
    const now = Date.now();

    if (action === 'like') {
      await env.DB.prepare(
        `INSERT INTO shorts_likes (video_id, delta_likes, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(video_id) DO UPDATE SET
           delta_likes = shorts_likes.delta_likes + 1,
           updated_at = excluded.updated_at`
      )
        .bind(videoId, now)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE shorts_likes
         SET delta_likes = MAX(0, delta_likes - 1), updated_at = ?
         WHERE video_id = ?`
      )
        .bind(now, videoId)
        .run();
    }

    const row = await env.DB.prepare(
      `SELECT delta_likes FROM shorts_likes WHERE video_id = ?`
    )
      .bind(videoId)
      .first<{ delta_likes: number }>();

    return jsonResponse({
      ok: true,
      video_id: videoId,
      delta_likes: Number(row?.delta_likes) || 0,
    });
  } catch {
    return jsonResponse({ error: 'Could not update like count.' }, 500);
  }
};
