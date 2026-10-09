import { api } from '../lib/api';
import { isDevAuthBypass, previewNotifications } from '../config/devPreview';

/**
 * The caller's notifications, newest first.
 *
 * `unreadCount` is a real aggregate — the controller counts unseen rows
 * separately from the page precisely so the bell badge is not quietly capped at
 * PAGE_SIZE. It is a total, not "unseen among the most recent page".
 *
 * `unseenOnly: true` narrows the list itself, which is the unread filter on the
 * notifications page; it does not change `unreadCount`, which stays the total.
 *
 * @param {{ before?: string, unseenOnly?: boolean }} [options] - `before` is
 *   the opaque `created_at|id` cursor from the previous page
 * @returns {{ notifications: Array, unreadCount: number, nextCursor: string|null }}
 */
export async function listNotifications({ before, unseenOnly } = {}) {
  if (isDevAuthBypass) {
    const rows = unseenOnly
      ? previewNotifications.filter((notification) => !notification.seen)
      : previewNotifications;
    return {
      notifications: rows,
      unreadCount: previewNotifications.filter((n) => !n.seen).length,
      nextCursor: null,
    };
  }
  const { data } = await api.get('/notifications', {
    params: { before, unseenOnly: unseenOnly ? 'true' : undefined },
  });
  return data.data;
}

/**
 * Mark notifications seen — one, or all of them.
 *
 * The response is `{ updated }`, the count of rows THIS call changed, not the
 * total remaining. The client subtracts it, so a badge can be corrected
 * without a second request.
 *
 * Marking something already seen returns a 404 for the single path; the server
 * treats "not yours" and "already seen" as the same answer on purpose, since
 * distinguishing them would confirm a UUID exists to a stranger.
 *
 * @param {{ notificationId?: string, all?: true }} payload
 * @returns {Promise<{ updated: number }>}
 */
export async function markSeen({ notificationId, all } = {}) {
  if (isDevAuthBypass) {
    const count = all
      ? previewNotifications.filter((n) => !n.seen).length
      : previewNotifications.filter((n) => n.id === notificationId && !n.seen).length;
    return { updated: count };
  }
  const { data } = await api.patch('/notifications/seen', { notificationId, all });
  return data.data;
}
