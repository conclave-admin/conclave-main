import { api } from "../lib/api";
import { isDevAuthBypass, previewTasks, previewRooms, previewUser } from "../config/devPreview";

const previewUpdates = new Map();

/** Mirrors `STATUSES` in tasks.controller.js and the DB check constraint. */
export const TASK_STATUSES = ["open", "in_progress", "done"];

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
export async function listTasks({ roomId, status, assigneeId, decisionId, before } = {}) {
  if (isDevAuthBypass) {
    return {
      tasks: previewTasks.filter(
        (task) =>
          (!roomId || task.room_id === roomId) &&
          (!status || task.status === status) &&
          (!assigneeId || task.assignee_id === assigneeId) &&
          (!decisionId || task.decision_id === decisionId),
      ), nextCursor: null,
    };
  }
  const { data } = await api.get("/tasks", {
    params: { roomId, status, assigneeId, decisionId, before },
  });
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
 * Task changes emit identifiers to current room members' personal sockets.
 *
 * @param {{ roomId: string, sourceMessageId?: string, title: string, assigneeId?: string, dueDate?: string }} payload
 */
export async function createTask({
  roomId,
  sourceMessageId,
  decisionId,
  title,
  body,
  assigneeId,
  dueDate,
  clientId,
}) {
  if (isDevAuthBypass) {
    const room = previewRooms.find((item) => item.id === roomId);
    const task = { id: crypto.randomUUID(), room_id: roomId,
      room_name: room?.name || "Conversation", room_slug: room?.slug || null,
      source_message_id: sourceMessageId || null, title, body: body || null,
      decision_id: decisionId || null,
      assignee_id: assigneeId || null, assignee_name: room?.members?.find((member) => member.id === assigneeId)?.display_name || null,
      due_date: dueDate || null, status: "open", created_by: previewUser.id,
      creator_name: previewUser.display_name, can_manage: true, can_progress: assigneeId === previewUser.id,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    previewTasks.unshift(task);
    return task;
  }
  const { data } = await api.post("/tasks", {
    roomId,
    sourceMessageId,
    decisionId,
    title,
    // Sent as null rather than omitted so an intentionally empty Notes field and
    // a dialog that never offered one are the same thing server-side. This was
    // collected in the dialog for a long time and never transmitted at all.
    body: body ? body.trim() : null,
    assigneeId,
    // Sent as `YYYY-MM-DD`, the shape the controller returns from
    // to_char(due_date, 'YYYY-MM-DD') — so a round trip does not shift a date.
    dueDate,
    clientId,
  });
  return data.data;
}

/**
 * Move a task between board columns.
 *
 * Only the assigned member can move progress. The server records each change
 * in task activity and updates the digest timestamp.
 *
 * @param {string} taskId
 * @param {'open'|'in_progress'|'done'} status
 */
export async function updateTaskStatus(taskId, status) {
  if (isDevAuthBypass) {
    const task = previewTasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Task not found");
    task.status = status; task.updated_at = new Date().toISOString();
    return { ...task };
  }
  const { data } = await api.patch(`/tasks/${taskId}/status`, { status });
  return data.data;
}

export async function getTask(taskId, before) {
  if (isDevAuthBypass) return { task: previewTasks.find((task) => task.id === taskId), updates: previewUpdates.get(taskId) || [], nextCursor: null };
  const { data } = await api.get(`/tasks/${taskId}`, { params: { before } });
  return data.data;
}

export async function editTask(taskId, fields) {
  if (isDevAuthBypass) {
    const task = previewTasks.find((item) => item.id === taskId);
    Object.assign(task, { title: fields.title, body: fields.body, due_date: fields.dueDate,
      assignee_id: fields.assigneeId, updated_at: new Date().toISOString() });
    return { ...task };
  }
  const { data } = await api.patch(`/tasks/${taskId}`, fields);
  return data.data;
}

export async function addTaskUpdate(taskId, body) {
  if (isDevAuthBypass) {
    const task = previewTasks.find((item) => item.id === taskId);
    const updates = previewUpdates.get(taskId) || [];
    updates.unshift({ id: crypto.randomUUID(), kind: "note", body,
      author_name: previewUser.display_name, created_at: new Date().toISOString() });
    previewUpdates.set(taskId, updates);
    task.updated_at = new Date().toISOString();
    return { ...task };
  }
  const { data } = await api.post(`/tasks/${taskId}/updates`, { body });
  return data.data;
}
