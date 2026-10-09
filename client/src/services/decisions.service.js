import { api } from '../lib/api';
import { isDevAuthBypass, previewDecisions } from '../config/devPreview';

/**
 * Decisions for one room, pins included.
 *
 * Room-scoped rather than the cross-room list: the strip under a header is
 * about the room you are looking in, and a cross-room fetch would have to be
 * filtered client-side while still paying for every other room's decisions.
 */
export async function listRoomDecisions(roomId) {
  // Bypass returns only the preview decisions that belong to this room. The
  // other two belong to rooms that do not exist offline, and showing them in
  // the strip would mean a pin appearing in a conversation it never reached.
  if (isDevAuthBypass) {
    return previewDecisions.filter((decision) => decision.room_id === roomId);
  }
  const { data } = await api.get('/decisions', { params: { roomId } });
  return data.data.decisions;
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
