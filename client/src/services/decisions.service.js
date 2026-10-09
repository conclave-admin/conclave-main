import { api } from '../lib/api';
import { isDevAuthBypass, previewDecisions } from '../config/devPreview';

// Bypass returns only the preview decisions that belong to the requested room.
// The other fixtures belong to rooms that do not exist offline, so showing
// them would mean a decision appearing in a conversation it never reached.
function previewFor(roomId) {
  return roomId
    ? previewDecisions.filter((decision) => decision.room_id === roomId)
    : previewDecisions;
}

/**
 * Decisions across every room the caller is in.
 *
 * Cross-room by default because `/decisions` is a top-level page; pass
 * `roomId` for the single-room view. Both come from the same endpoint.
 *
 * @param {{ roomId?: string, before?: string }} [options] - `before` is the
 *   opaque `created_at|id` cursor from the previous page
 * @returns {{ decisions: Array, nextCursor: string|null }}
 */
export async function listDecisions({ roomId, before } = {}) {
  if (isDevAuthBypass) return { decisions: previewFor(roomId), nextCursor: null };
  const { data } = await api.get('/decisions', {
    params: { roomId, before },
  });
  return data.data;
}

/**
 * Full-text search across decisions — title, body and tags.
 *
 * Cross-room unless `roomId` is given. Search and list are separate endpoints
 * rather than a `?q=` on the list, because search is ranked by ts_rank and the
 * list is ordered by recency; one endpoint doing both would have to pick.
 *
 * @param {string} q
 * @param {string} [roomId]
 */
export async function searchDecisions(q, roomId) {
  if (isDevAuthBypass) {
    const needle = q.trim().toLowerCase();
    return previewFor(roomId).filter(
      (decision) =>
        decision.title.toLowerCase().includes(needle) ||
        decision.body.toLowerCase().includes(needle) ||
        (decision.tags || []).some((tag) => tag.includes(needle)),
    );
  }
  const { data } = await api.get('/decisions/search', { params: { q, roomId } });
  return data.data.decisions;
}

/**
 * One decision, in the joined shape the list returns, pins attached.
 *
 * Backed by GET /decisions/:decisionId, added in phase 6 so the pinned strip
 * can resolve to the decision itself rather than to the board. A 403 covers
 * both "not in that room" and "does not exist" — the server deliberately does
 * not distinguish them, since saying "not found" would confirm a UUID exists.
 *
 * @param {string} decisionId
 */
export async function getDecision(decisionId) {
  if (isDevAuthBypass) {
    const found = previewDecisions.find((decision) => decision.id === decisionId);
    if (!found) throw new Error('Decision not found');
    return found;
  }
  const { data } = await api.get(`/decisions/${decisionId}`);
  return data.data;
}

/**
 * Promote a message to a decision.
 *
 * `sourceMessageId` is optional server-side, but the flow this phase builds is
 * promote-from-message, so the caller normally supplies it — which is what
 * keeps the decision linked back to the message that produced it.
 *
 * @param {{ roomId: string, sourceMessageId?: string, title: string, body: string, tags?: string[] }} payload
 */
export async function promoteToDecision({ roomId, sourceMessageId, title, body, tags }) {
  const { data } = await api.post('/decisions', {
    roomId,
    sourceMessageId,
    title,
    body,
    tags: tags || [],
  });
  return data.data;
}

/**
 * Pin a decision.
 *
 * `scope: 'user'` bookmarks it for the caller alone. `scope: 'room'` pins it
 * for every member — any room member may do either, and the difference is
 * blast radius rather than privilege.
 *
 * A 409 means somebody else already holds the room pin; the message names them.
 *
 * @param {string} decisionId
 * @param {'user'|'room'} scope
 */
export async function pinDecision(decisionId, scope) {
  const { data } = await api.put(`/decisions/${decisionId}/pin`, { scope });
  return data.data;
}

/**
 * Remove a pin.
 *
 * Personal pins belong to their author. A room pin may be removed by whoever
 * set it or by a room admin — the server decides, and a 403 is it deciding no.
 *
 * @param {string} decisionId
 * @param {'user'|'room'} scope
 */
export async function unpinDecision(decisionId, scope) {
  const { data } = await api.delete(`/decisions/${decisionId}/pin/${scope}`);
  return data.data;
}
