const { query } = require('../config/db');
const { UUID } = require('../utils/mediaPagination');
const ApiError = require('../utils/ApiError');
const { withRoomMembership } = require('./realtimeAccess.service');

async function attachReceiptSummaries(messages, db = { query }) {
  if (!messages.length) return messages;
  const result = await db.query(`SELECT m.id, m.state_version, m.receipt_history_complete, m.receipt_version,
    COUNT(r.recipient_id)::int AS recipient_count,
    COUNT(r.recipient_id) FILTER (WHERE r.delivered)::int AS delivered_count,
    COUNT(r.recipient_id) FILTER (WHERE r.read)::int AS read_count
    FROM messages m LEFT JOIN message_recipients r ON r.message_id = m.id
    WHERE m.id = ANY($1::uuid[]) GROUP BY m.id`, [messages.map(m => m.id)]);
  const versions = new Map(result.rows.map(row => [row.id, Number(row.state_version)]));
  const summaries = new Map(result.rows.map(row => [row.id, {
    recipient_count: row.recipient_count, delivered_count: row.delivered_count,
    read_count: row.read_count, history_complete: row.receipt_history_complete,
    version: Number(row.receipt_version),
  }]));
  return messages.map(message => {const {state_version,...payload}=message;return {...payload,sync_version:state_version==null?versions.get(message.id):Number(state_version),receipt_summary:summaries.get(message.id)||null};});
}

// A read acknowledges this message only. Gaps remain unread even if the user
// jumps to a later message; legacy room pointers advance only over closed gaps.
async function acknowledge({ roomId, userId, messageId, read = false, all = false, io, authorize }) {
  if (!UUID.test(roomId) || (!all && (typeof messageId !== 'string' || !UUID.test(messageId)))) throw new ApiError(400, 'Valid room and message IDs are required');
  const result = await withRoomMembership(roomId, userId, async db => {
    if (authorize && !await authorize()) throw new ApiError(409, 'Open this conversation in an active window before marking messages read');
    await db.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2 FOR UPDATE', [roomId, userId]);
    if (!all && !(await db.query('SELECT 1 FROM messages WHERE id=$1 AND room_id=$2', [messageId, roomId])).rowCount) throw new ApiError(404, 'Message not found');
    const changed = await db.query(`UPDATE message_recipients r SET delivered=TRUE,
      delivered_at=CASE WHEN r.delivered THEN r.delivered_at ELSE NOW() END,
      read=r.read OR $4, read_at=CASE WHEN $4 AND NOT r.read THEN NOW() ELSE r.read_at END
      FROM messages m WHERE m.id=r.message_id AND m.room_id=$1 AND r.recipient_id=$2
      AND ($5 OR m.id=$3::uuid) AND (NOT r.delivered OR ($4 AND NOT r.read)) RETURNING r.message_id`,
      [roomId, userId, messageId || null, read, all]);
    const ids = changed.rows.map(row => row.message_id);
    if (ids.length) await db.query('UPDATE messages SET receipt_version=receipt_version+1 WHERE id=ANY($1::uuid[])', [ids]);
    const pointer = await db.query(`WITH boundary AS (
      SELECT COALESCE(MIN(m.room_sequence)-1, (SELECT message_sequence FROM rooms WHERE id=$1)) AS seq
      FROM message_recipients r JOIN messages m ON m.id=r.message_id
      WHERE m.room_id=$1 AND r.recipient_id=$2 AND NOT r.read AND m.deleted_at IS NULL
    ), delivered_boundary AS (
      SELECT COALESCE(MIN(m.room_sequence)-1, (SELECT message_sequence FROM rooms WHERE id=$1)) AS seq
      FROM message_recipients r JOIN messages m ON m.id=r.message_id
      WHERE m.room_id=$1 AND r.recipient_id=$2 AND NOT r.delivered AND m.deleted_at IS NULL
    ) UPDATE room_members SET
      last_seen_sequence=GREATEST(last_seen_sequence, CASE WHEN $3 THEN (SELECT seq FROM boundary) ELSE last_seen_sequence END),
      last_delivered_sequence=GREATEST(last_delivered_sequence, (SELECT seq FROM delivered_boundary)),
      last_seen_at=CASE WHEN $4 THEN NOW() WHEN $3 THEN GREATEST(last_seen_at, COALESCE((SELECT MAX(created_at) FROM messages WHERE room_id=$1 AND room_sequence <= (SELECT seq FROM boundary)),last_seen_at)) ELSE last_seen_at END
      WHERE room_id=$1 AND user_id=$2 RETURNING last_seen_at,last_seen_sequence,last_delivered_sequence`, [roomId,userId,read,all]);
    const receipts = await attachReceiptSummaries(ids.map(id => ({ id })), db);
    return { ...pointer.rows[0], receipts: receipts.map(m => ({ messageId: m.id, receipt_summary: m.receipt_summary })) };
  });
  if (io) {
    if (result.receipts.length) io.to(roomId).emit('message:receipts', { roomId, receipts: result.receipts });
    io.to(roomId).emit(read ? 'message-read' : 'message-delivered', { roomId, messageId, userId,
      lastSeenAt: result.last_seen_at, lastSeenSequence: result.last_seen_sequence,
      lastDeliveredSequence: result.last_delivered_sequence });
    if (read) await require('./notification.service').emitChatUpdated(io, roomId);
  }
  return result;
}
async function details(messageId, userId) {
  const owned = await query(`SELECT m.id, m.room_id, m.created_at FROM messages m
    JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=$2
    WHERE m.id=$1 AND m.sender_id=$2`, [messageId,userId]);
  if (!owned.rows.length) throw new ApiError(404, 'Message information unavailable');
  const recipients = await query(`SELECT r.recipient_id AS user_id,
    CASE WHEN u.id IS NULL OR u.deleted_at IS NOT NULL THEN 'Deleted account' ELSE COALESCE(u.display_name,r.recipient_name) END AS display_name,
    r.delivered, r.read, r.delivered_at, r.read_at, (rm.user_id IS NOT NULL) AS current_member
    FROM message_recipients r JOIN messages m ON m.id=r.message_id
    LEFT JOIN users u ON u.id=r.recipient_id
    LEFT JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=r.recipient_id
    WHERE r.message_id=$1 ORDER BY r.read DESC, r.delivered DESC, display_name, r.recipient_id`, [messageId]);
  const [message] = await attachReceiptSummaries(owned.rows);
  return { messageId, sentAt: message.created_at, summary: message.receipt_summary, recipients: recipients.rows };
}
module.exports = { attachReceiptSummaries, acknowledge, details };
