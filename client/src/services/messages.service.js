import { api } from '../lib/api';
import { isDevAuthBypass, previewMessages } from '../config/devPreview';

export async function listMessages(roomId, before) {
  if (isDevAuthBypass) {
    return {
      messages: [...previewMessages].reverse().map((message) => ({
        ...message,
        room_id: roomId,
      })),
      nextCursor: null,
    };
  }
  const { data } = await api.get(`/messages/room/${roomId}`, {
    params: before ? { before } : undefined,
  });
  return data.data;
}

/**
 * Edit a message body.
 *
 * Author-only server-side, with no time limit. Mentions and attachments are
 * deliberately not editable — both are recorded facts about what was sent, and
 * letting an edit rewrite them would change who was notified after the fact.
 * A 403 from someone else's message is the server enforcing that, not a bug.
 */
export async function editMessage(messageId, content) {
  const { data } = await api.patch(`/messages/${messageId}`, { content });
  return data.data;
}

/**
 * Soft-delete a message.
 *
 * The response is the tombstone, not a 204: the timeline keeps the row so
 * ordering and replies hold, and the client swaps in what comes back rather
 * than guessing at what a deleted message should look like.
 */
export async function deleteMessage(messageId) {
  const { data } = await api.delete(`/messages/${messageId}`);
  return data.data;
}

/**
 * Add the caller's reaction.
 *
 * Idempotent — reacting twice does not stack, so this is safe to call from a
 * chip that is already lit.
 */
export async function addReaction(messageId, emoji) {
  const { data } = await api.put(`/messages/${messageId}/reactions`, { emoji });
  return data.data;
}

/**
 * Remove the caller's own reaction.
 *
 * The emoji is percent-encoded because it is a multi-byte character in a path
 * segment. Skipping this makes a legitimate 👍 fail the server's allowlist as
 * "%F0%9F%91%8D" — the server decodes, but only if the client encoded first.
 * Removing an absent reaction succeeds, so this is safe to call either way.
 */
export async function removeReaction(messageId, emoji) {
  const { data } = await api.delete(
    `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
  );
  return data.data;
}

/**
 * Upload one file and return the descriptor to send as a message attachment.
 *
 * Multipart, so axios sets the boundary itself — forcing a content-type header
 * here would break it. The server answers with `{ filename, url, mime_type,
 * size }`, but a message attachment takes only `{ url }`: the other three are
 * read back from the upload record so a client cannot claim its own file is a
 * different size or type than the bytes it just sent.
 */
export async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/upload', form);
  return data.data;
}
