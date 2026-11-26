import { isQuietNow } from "./quietHours.js";

// Should an incoming notification interrupt the user inside the app?
//
// Extracted from ChatsContext so the rule can be unit-tested: it is the one
// place where a preference, a room state and the current screen all decide
// whether a sound plays, and getting any branch wrong is silent — the user
// just does or does not get an alert, with nothing to explain why.
//
// It mirrors the server's `allowsInterruption` (notificationPolicy.service)
// closely enough for an in-app alert, which is lower stakes than push: a stale
// read here means a toast appears a few seconds late, never that private
// content leaks. It may only ever be *stricter* than the server, never laxer —
// this never turns an interruption the user suppressed back on.

/** Only these interrupt. Invites, joins, tasks and decisions stay in the bell. */
export const ALERTABLE_TYPES = [
  "mention",
  "new_message",
  "file_uploaded",
  "reminder",
];

/**
 * @param {object} input
 * @param {{type: string, context?: {room_id?: string}}} input.notification
 * @param {string|null} [input.activeRoomId] - conversation open in this tab
 * @param {{activityLevel?: string, muted?: Record<string, boolean>,
 *          dndUntil?: string|null, inAppAlerts?: boolean,
 *          quietHours?: Array, quietHoursTimezone?: string}} [input.policy]
 * @param {string[]} [input.mutedRooms]
 * @param {string[]} [input.archivedRooms]
 * @param {string} [input.visibilityState] - only visible documents interrupt
 * @param {Date} [input.now]
 * @returns {boolean}
 */
export function shouldAlert({
  notification,
  activeRoomId = null,
  policy = {},
  mutedRooms = [],
  archivedRooms = [],
  now = new Date(),
  visibilityState = "visible",
}) {
  if (visibilityState !== "visible") return false;
  if (!notification) return false;
  if (!ALERTABLE_TYPES.includes(notification.type)) return false;

  const roomId = notification.context?.room_id;
  if (!roomId) return false;

  // The conversation is already on screen: the user watched it arrive.
  if (activeRoomId === roomId) return false;

  // Muted and archived are room-level decisions the user already made;
  // an alert for either resurfaces something they put away.
  if (mutedRooms.includes(roomId)) return false;
  if (archivedRooms.includes(roomId)) return false;

  if (policy.inAppAlerts === false) return false;

  // The same three values migration 015 constrains. Under "mentions" only a
  // real mention may interrupt — which is exactly why this runs on the
  // notification event and not on every message.
  if (policy.activityLevel === "none") return false;
  if (policy.activityLevel === "mentions" && notification.type !== "mention")
    return false;

  // Per-type override from the notification preferences map.
  if (policy.muted?.[notification.type]) return false;

  // An active do-not-disturb window. Missing or past means off.
  if (policy.dndUntil && new Date(policy.dndUntil) > now) return false;
  if (isQuietNow(policy.quietHours, policy.quietHoursTimezone, now)) return false;

  return true;
}
