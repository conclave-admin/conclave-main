import { api } from '../lib/api';
import { isDevAuthBypass, previewDigestItems, previewDigestSummary } from '../config/devPreview';

/**
 * The catch-up digest, cross-room.
 *
 * GET /digest is already implemented and tested on the server: it aggregates
 * decisions, tasks, mentions, files and activity across every room the caller
 * is in, each filtered against that room's OWN last_seen_at rather than one
 * shared timestamp. The chat list's Catch-up card is a subset of this same
 * response, so the two can never disagree about what is new — they read one
 * payload rather than two implementations of "unread".
 *
 * @returns {{ items: Array, summary: { headline: string, summary: string } }}
 */
export async function getUserDigest() {
  if (isDevAuthBypass) {
    return { items: previewDigestItems, summary: previewDigestSummary };
  }
  const { data } = await api.get('/digest');
  return data.data;
}
