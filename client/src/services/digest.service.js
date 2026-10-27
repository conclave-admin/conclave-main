import { api } from "../lib/api";
import {
  isDevAuthBypass,
  previewDigestItems,
  previewDigestSummary,
} from "../config/devPreview";

/**
 * The catch-up digest, cross-room.
 *
 * GET /digest aggregates decisions, tasks, mentions, files and room pins across
 * every room the caller is in, each filtered against that room's OWN
 * digest_seen_at rather than one shared timestamp.
 *
 * The digest used to filter on last_seen_at, the read receipt — so opening a
 * room advanced the pointer and the backlog it was reporting on disappeared.
 * Migration 018 splits the two; see markDigestRead below.
 *
 * @returns {{ items: Array, summary: { headline: string, summary: string } }}
 */
export async function getUserDigest(cursor = null) {
  if (isDevAuthBypass) {
    const items = previewDigestItems.filter((item) => !previewReadRooms.has(item.room_id));
    const counts = Object.fromEntries(["decision", "task", "mention", "file", "pin"]
      .map((type) => [type, items.filter((item) => item.type === type).length]));
    const parts = [
      counts.mention && `${counts.mention} for you`,
      (counts.decision + counts.task) && `${counts.decision + counts.task} decision or task updates`,
      (counts.file + counts.pin) && `${counts.file + counts.pin} shared items`,
    ].filter(Boolean);
    return {
      items,
      next_cursor: null,
      rooms: [...new Set(previewDigestItems.map((item) => item.room_id))].map((room_id) => ({ room_id })),
      snapshot_at: new Date().toISOString(),
      summary: items.length === previewDigestItems.length ? previewDigestSummary : {
        headline: items.length ? `${items.length} update${items.length === 1 ? "" : "s"} worth a look` : "You're caught up",
        summary: parts.length ? parts.join(" · ") : "No important updates since you last marked the digest as read.",
      },
    };
  }
  const { data } = await api.get("/digest", { params: cursor ? { cursor } : {} });
  return data.data;
}

/**
 * Advance the digest pointer for one room, selected rooms, or all rooms.
 * `observedAt` is the snapshot shown to the user; newer events stay unread.
 *
 * Explicit and deliberate rather than a side effect of viewing the page. If
 * reading the digest also cleared it, then opening it in a second tab — or
 * reloading — would silently discard a backlog you had not finished reading.
 */
const previewReadRooms = new Set();

export async function markDigestRead({ roomId, roomIds, observedAt } = {}) {
  if (isDevAuthBypass) {
    for (const id of roomId ? [roomId] : roomIds || previewDigestItems.map((item) => item.room_id))
      previewReadRooms.add(id);
    window.dispatchEvent(new Event("conclave:digest-changed"));
    return { rooms: [...previewReadRooms], digestSeenAt: observedAt || new Date().toISOString() };
  }
  const { data } = await api.post("/digest/read", { roomId, roomIds, observedAt });
  window.dispatchEvent(new Event("conclave:digest-changed"));
  return data.data;
}
