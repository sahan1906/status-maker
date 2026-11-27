import { jsonResponse } from '../_lib/security';
import { PagesHandler } from '../_lib/types';
import { ensureShortsVideosTable } from './shorts';

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  let body: { video_id?: unknown; action?: unknown };
  try {
    body = (await request.json()) as { video_id?: unknown; action?: unknown };
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload.' }, 400);
  }

  const videoId = typeof body.video_id === 'string' ? body.video_id.trim() : '';
  const action = body.action === 'unlike' ? 'unlike' : 'like';

  if (!videoId || !/^[a-zA-Z0-9_-]{3,64}$/.test(videoId)) {
    return jsonResponse({ error: 'Invalid short ID.' }, 400);
  }

  try {
    await ensureShortsVideosTable(env.DB);
    if (action === 'like') {
      await env.DB.prepare(`UPDATE shorts_videos SET likes = likes + 1 WHERE id = ?`)
        .bind(videoId)
        .run();
    } else {
      await env.DB.prepare(`UPDATE shorts_videos SET likes = MAX(0, likes - 1) WHERE id = ?`)
        .bind(videoId)
        .run();
    }

    const row = await env.DB.prepare(`SELECT likes FROM shorts_videos WHERE id = ?`)
      .bind(videoId)
      .first<{ likes: number }>();

    return jsonResponse({
      ok: true,
      video_id: videoId,
      likes: Number(row?.likes) || 0,
    });
  } catch {
    return jsonResponse({ error: 'Could not update like count.' }, 500);
  }
};
