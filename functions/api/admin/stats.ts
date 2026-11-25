import { jsonResponse, verifyAdminRequest } from '../../_lib/security';
import { PagesHandler } from '../../_lib/types';

export const onRequestGet: PagesHandler = async ({ request, env }) => {
  const authed = await verifyAdminRequest(request, env);
  if (!authed) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const totals = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total_users,
       COALESCE(SUM(videos_created), 0) AS total_videos,
       SUM(CASE WHEN last_active_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS active_today
     FROM users`
  ).first<{
    total_users: number;
    total_videos: number;
    active_today: number | null;
  }>();

  return jsonResponse({
    totalUsers: Number(totals?.total_users || 0),
    totalVideos: Number(totals?.total_videos || 0),
    activeToday: Number(totals?.active_today || 0),
  });
};
