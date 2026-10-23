import { api } from "../lib/api";
import {
  isDevAuthBypass,
  previewDigestItems,
  previewDigestSummary,
} from "../config/devPreview";

/**
 * The catch-up digest, cross-room.
 *
 * GET /digest aggregates decisions, tasks, mentions, files and activity across
 * every room the caller is in, each filtered against that room's OWN
 * digest_seen_at rather than one shared timestamp.
 *
 * The digest used to filter on last_seen_at, the read receipt — so opening a
 * room advanced the pointer and the backlog it was reporting on disappeared.
 * Migration 018 splits the two; see markDigestRead below.
 *
 * @returns {{ items: Array, summary: { headline: string, summary: string } }}
 */
export async function getUserDigest() {
  if (isDevAuthBypass) {
    return { items: previewDigestItems, summary: previewDigestSummary };
  }
  const { data } = await api.get("/digest");
  return data.data;
}

/**
 * Advance the digest pointer for the rooms in `roomIds`, or every room the
 * caller is in when omitted.
 *
 * Explicit and deliberate rather than a side effect of viewing the page. If
 * reading the digest also cleared it, then opening it in a second tab — or
 * reloading — would silently discard a backlog you had not finished reading.
 */
export async function markDigestRead(roomIds) {
  if (isDevAuthBypass)
    return { rooms: roomIds || [], digestSeenAt: new Date().toISOString() };
  const { data } = await api.post(
    "/digest/read",
    roomIds ? { roomId: roomIds } : {},
  );
  return data.data;
}
