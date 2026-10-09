/**
 * Derived facts about a message: time labels, grouping, and read status.
 *
 * Kept out of the components because three of them need the same answers and
 * each would otherwise re-derive them slightly differently — which is how a
 * timeline ends up splitting a run of messages in one place and joining it in
 * another.
 */

/**
 * The server's reaction allowlist, in its order.
 *
 * Mirrors `REACTION_EMOJI` in backend/src/services/reaction.service.js and the
 * CHECK constraint in migration 013 — all three must stay in step. A heart is
 * deliberately absent: ❤️ has two encodings (U+2764 and U+2764 U+FE0F) and
 * Postgres treats them as different strings, so it would either be rejected or
 * stack twice against the unique constraint. These four have one encoding each.
 */
export const REACTION_EMOJI = ['👍', '👎', '🎉', '✅'];

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function isSameDay(a, b) {
  if (!a || !b) return false;
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/** "Today", "Yesterday", "October 8", or "October 8, 2024" — never a raw ISO. */
export function daySeparatorLabel(value, now = new Date()) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';

  const options =
    date.getFullYear() === now.getFullYear()
      ? { month: 'long', day: 'numeric' }
      : { month: 'long', day: 'numeric', year: 'numeric' };
  return date.toLocaleDateString('en-US', options);
}

/** The clock time shown beside a message and in a grouping run's last row. */
export function formatClockTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Does `next` continue the run started by `prev`?
 *
 * Tombstones break a run deliberately. A deleted message sitting in the middle
 * of four from the same author would otherwise inherit their avatar and hide
 * its own timestamp, and the reader would have to hunt for where the deletion
 * happened.
 */
export function isConsecutive(prev, next) {
  if (!prev || !next) return false;
  if (prev.sender_id !== next.sender_id) return false;
  if (prev.is_deleted || next.is_deleted) return false;
  return isSameDay(prev.created_at, next.created_at);
}

/**
 * Annotate a timeline with grouping flags.
 *
 * `_startsDay`   no separator is needed above this one
 * `_consecutive` renders without an avatar, name or timestamp
 * `_endsGroup`   the last of its run, so the timestamp and tick sit here
 *
 * @param {Array} messages - ascending by created_at
 * @returns {Array} new objects; the input is not mutated
 */
export function annotateMessages(messages = []) {
  return messages.map((message, index) => {
    const prev = messages[index - 1];
    const next = messages[index + 1];
    return {
      ...message,
      _startsDay: !prev || !isSameDay(prev.created_at, message.created_at),
      _consecutive: isConsecutive(prev, message),
      _endsGroup: !next || !isConsecutive(message, next),
    };
  });
}

/**
 * Delivery status for one of the caller's own messages.
 *
 * `pending` the send has not been acknowledged yet
 * `failed`  it errored and the composer surfaced it
 * `sent`    the server stored it
 * `read`    at least one other member's read pointer has reached it
 *
 * The read tick is derived, not stored per message. `room_members.last_seen_at`
 * is a pointer per member per room, so "has U read M" is a comparison rather
 * than a row — which is exactly why it survives a reload. The tick means
 * somebody has caught up, not everybody: in a room of forty people waiting for
 * unanimous catch-up would mean a tick that almost never appears.
 *
 * @returns {'pending'|'failed'|'sent'|'read'|null} null when not the viewer's message
 */
export function readStatus(message, members = [], viewerId, pendingIds = new Set(), failedIds = new Set()) {
  if (!message || message.sender_id !== viewerId) return null;
  if (failedIds.has(message.id)) return 'failed';
  if (pendingIds.has(message.id)) return 'pending';

  const created = new Date(message.created_at).getTime();
  const others = members.filter((member) => member.id !== viewerId);
  const hasReader = others.some(
    (member) => new Date(member.last_seen_at).getTime() >= created,
  );

  return hasReader ? 'read' : 'sent';
}
