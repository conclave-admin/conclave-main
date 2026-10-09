import { api } from '../lib/api';
import { isDevAuthBypass, previewTasks } from '../config/devPreview';

/** Mirrors `STATUSES` in tasks.controller.js and the DB check constraint. */
export const TASK_STATUSES = ['open', 'in_progress', 'done'];

/**
 * Tasks across every room the caller is in.
 *
 * Cross-room by default because the Tasks page is top-level in the rail.
 * `status` and `assigneeId` narrow further; both are server-side filters, so
 * the three board columns are three views of one response rather than three
 * requests the client then re-filters.
 *
 * @param {{ roomId?: string, status?: string, assigneeId?: string }} [options]
 * @returns {{ tasks: Array }}
 */
export async function listTasks({ roomId, status, assigneeId } = {}) {
  if (isDevAuthBypass) {
    return {
      tasks: previewTasks.filter(
        (task) =>
          (!roomId || task.room_id === roomId) &&
          (!status || task.status === status) &&
          (!assigneeId || task.assignee_id === assigneeId),
      ),
    };
  }
  const { data } = await api.get('/tasks', { params: { roomId, status, assigneeId } });
  return data.data;
}

/**
 * Flag a message as a task.
 *
 * The server validates that `sourceMessageId` is a message in `roomId` and
 * that `assigneeId` is a member of that room — both 400s, so a mismatched
 * pick fails loudly rather than creating a task that points somewhere the
 * assignee cannot open.
 *
 * Emits `task:updated` to the room, which reaches sockets that have joined it.
 * A viewer sitting on the cross-room board has not joined, so their board
 * refreshes on reload only; that limitation is documented in tasks.controller.js.
 *
 * @param {{ roomId: string, sourceMessageId?: string, title: string, assigneeId?: string, dueDate?: string }} payload
 */
export async function createTask({ roomId, sourceMessageId, title, assigneeId, dueDate }) {
  const { data } = await api.post('/tasks', {
    roomId,
    sourceMessageId,
    title,
    assigneeId,
    // Sent as `YYYY-MM-DD`, the shape the controller returns from
    // to_char(due_date, 'YYYY-MM-DD') — so a round trip does not shift a date.
    dueDate,
  });
  return data.data;
}

/**
 * Move a task between board columns.
 *
 * The only mutation the board offers. `updated_at` is set server-side, and
 * that matters: the digest's whole window is `updated_at > last_seen_at`, so a
 * status change that did not touch the timestamp would never surface in
 * anyone's catch-up feed.
 *
 * @param {string} taskId
 * @param {'open'|'in_progress'|'done'} status
 */
export async function updateTaskStatus(taskId, status) {
  const { data } = await api.patch(`/tasks/${taskId}/status`, { status });
  return data.data;
}
