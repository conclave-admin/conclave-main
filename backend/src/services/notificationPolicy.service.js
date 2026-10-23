const { pool } = require("../config/db");
// Same record visibility for the bell, badge and interruption policy. Dangling
// references remain as context-free historical rows; revoked live targets do not.
function visibleSql(n = "n") {
  return `NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=${n}.recipient_id AND b.blocked_id=${n}.actor_id) OR (b.blocked_id=${n}.recipient_id AND b.blocker_id=${n}.actor_id))
    AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=${n}.reference_id AND ${n}.type IN ('mention','new_message','file_uploaded') AND NOT EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=m.room_id AND rm.user_id=${n}.recipient_id))
    AND NOT EXISTS(SELECT 1 FROM rooms r WHERE r.id=${n}.reference_id AND ${n}.type IN ('room_invite','member_joined') AND NOT EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=r.id AND rm.user_id=${n}.recipient_id))
    AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=${n}.reference_id AND ${n}.type='task' AND NOT EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=t.room_id AND rm.user_id=${n}.recipient_id))`;
}
function allowsInterruption(preferences = {}, type, roomMuted = false) {
  if (
    preferences.push_enabled === false ||
    preferences.activity_level === "none" ||
    roomMuted ||
    preferences.muted?.[type] === true
  )
    return false;
  return preferences.activity_level !== "mentions" || type === "mention";
}
async function interruption(notificationId) {
  const result = await pool.query(
    `SELECT n.*,p.activity_level,p.muted,p.push_enabled,
    COALESCE(m.room_id,t.room_id,r.id) AS room_id,COALESCE(rmp.muted,FALSE) AS room_muted,
    (m.deleted_at IS NOT NULL) AS message_deleted, ${visibleSql()} AS visible
    FROM notifications n LEFT JOIN notification_preferences p ON p.user_id=n.recipient_id
    LEFT JOIN messages m ON m.id=n.reference_id AND n.type IN ('mention','new_message','file_uploaded')
    LEFT JOIN tasks t ON t.id=n.reference_id AND n.type='task'
    LEFT JOIN rooms r ON r.id=n.reference_id AND n.type IN ('room_invite','member_joined')
    LEFT JOIN room_member_preferences rmp ON rmp.room_id=COALESCE(m.room_id,t.room_id,r.id) AND rmp.user_id=n.recipient_id
    WHERE n.id=$1`,
    [notificationId],
  );
  const n = result.rows[0];
  if (
    !n ||
    n.seen ||
    !n.visible ||
    n.message_deleted ||
    !n.room_id ||
    !allowsInterruption(n, n.type, n.room_muted)
  )
    return { allowed: false, notification: n };
  // Suppress only a known fresh foreground viewer. Redis failure defers push;
  // it must not bypass an active user's interruption preferences.
  const presence = require("./presence.service");
  const { redisClient } = require("../config/redis");
  if (!redisClient.isReady) throw new Error("Presence unavailable");
  const active = await presence.getRoomViewingUsers(n.room_id);
  return { allowed: !active.includes(n.recipient_id), notification: n };
}
module.exports = { visibleSql, allowsInterruption, interruption };
