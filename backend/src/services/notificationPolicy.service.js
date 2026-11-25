const { pool } = require("../config/db");
const { isQuietNow } = require("./quietHours");
// Same record visibility for the bell, badge and interruption policy. Dangling
// references remain as context-free historical rows; revoked live targets do not.
function visibleSql(n = "n") {
  return `NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=${n}.recipient_id AND b.blocked_id=${n}.actor_id) OR (b.blocked_id=${n}.recipient_id AND b.blocker_id=${n}.actor_id))
    AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=${n}.reference_id AND ${n}.type IN ('mention','new_message','file_uploaded','reminder') AND NOT message_visible(m.id,${n}.recipient_id))
    AND NOT EXISTS(SELECT 1 FROM rooms r WHERE r.id=${n}.reference_id AND ${n}.type IN ('room_invite','member_joined') AND NOT EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=r.id AND rm.user_id=${n}.recipient_id))
    AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=${n}.reference_id AND ${n}.type='task' AND NOT EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=t.room_id AND rm.user_id=${n}.recipient_id))
    AND NOT EXISTS(SELECT 1 FROM decisions d WHERE d.id=${n}.reference_id AND ${n}.type='decision' AND NOT EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=d.room_id AND rm.user_id=${n}.recipient_id))
    AND NOT EXISTS(SELECT 1 FROM room_events e WHERE e.id=${n}.reference_id AND ${n}.type IN ('event_reminder','event_cancelled') AND (NOT EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=e.room_id AND rm.user_id=${n}.recipient_id) OR (${n}.type='event_reminder' AND (e.status<>'scheduled' OR e.starts_at<=NOW()))))`;
}
function allowsInterruption(preferences = {}, type, roomMuted = false, now = new Date()) {
  if (
    (preferences.dnd_until && new Date(preferences.dnd_until) > now) ||
    isQuietNow(preferences.quiet_hours, preferences.quiet_hours_timezone, now) ||
    (preferences.room_mute_until &&
      new Date(preferences.room_mute_until) > new Date()) ||
    preferences.notification_level === "none" ||
    (preferences.notification_level === "mentions" && type !== "mention") ||
    preferences.push_enabled === false ||
    preferences.activity_level === "none" ||
    roomMuted ||
    preferences.muted?.[type] === true
  )
    return false;
  return preferences.activity_level !== "mentions" || type === "mention";
}
// How many other unseen, still-visible notifications of the same kind point
// at this room for this recipient. Used only to compose a grouped push body
// ("4 new messages in Marketing") — never to decide whether to interrupt,
// so it has no bearing on the privacy-sensitive `allowed` decision above.
async function unseenRoomCount(recipientId, roomId, excludeId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications n
     WHERE n.recipient_id=$1 AND n.id<>$2 AND n.seen=FALSE
       AND n.type IN ('mention','new_message','file_uploaded','reminder')
       AND EXISTS(SELECT 1 FROM messages m WHERE m.id=n.reference_id AND m.room_id=$3)
       AND ${visibleSql()}`,
    [recipientId, excludeId, roomId],
  );
  return result.rows[0].count;
}

async function interruption(notificationId) {
  const result = await pool.query(
    `SELECT n.*,p.activity_level,p.muted,p.push_enabled,p.push_preview_enabled,
    p.quiet_hours,p.quiet_hours_timezone,
    recipient.dnd_until,rmp.mute_until AS room_mute_until,rmp.notification_level,
    COALESCE(m.room_id,t.room_id,d.room_id,e.room_id,r.id) AS room_id,COALESCE(rmp.muted,FALSE) AS room_muted,
    (m.deleted_at IS NOT NULL) AS message_deleted, ${visibleSql()} AS visible,
    actor.display_name AS actor_name, sender.display_name AS sender_name,
    CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.content END AS message_content,
    room.name AS room_name, room.type AS room_type,
    t.title AS task_title, d.title AS decision_title,e.title AS event_title
    FROM notifications n LEFT JOIN users recipient ON recipient.id=n.recipient_id LEFT JOIN notification_preferences p ON p.user_id=n.recipient_id
    LEFT JOIN messages m ON m.id=n.reference_id AND n.type IN ('mention','new_message','file_uploaded','reminder')
    LEFT JOIN tasks t ON t.id=n.reference_id AND n.type='task'
    LEFT JOIN decisions d ON d.id=n.reference_id AND n.type='decision'
    LEFT JOIN room_events e ON e.id=n.reference_id AND n.type IN ('event_reminder','event_cancelled')
    LEFT JOIN rooms r ON r.id=n.reference_id AND n.type IN ('room_invite','member_joined')
    LEFT JOIN room_member_preferences rmp ON rmp.room_id=COALESCE(m.room_id,t.room_id,d.room_id,e.room_id,r.id) AND rmp.user_id=n.recipient_id
    LEFT JOIN users actor ON actor.id=n.actor_id
    LEFT JOIN users sender ON sender.id=m.sender_id
    LEFT JOIN rooms room ON room.id=COALESCE(m.room_id,t.room_id,d.room_id,e.room_id,r.id)
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
  // Suppress only a known fresh foreground viewer; the single-instance
  // presence fallback keeps this policy available without Redis.
  const presence = require("./presence.service");
  const active = await presence.getRoomViewingUsers(n.room_id);
  const allowed = !active.includes(n.recipient_id);
  const unseenCount = allowed
    ? await unseenRoomCount(n.recipient_id, n.room_id, n.id)
    : 0;
  return { allowed, notification: n, unseenCount };
}
module.exports = { visibleSql, allowsInterruption, interruption, unseenRoomCount };
