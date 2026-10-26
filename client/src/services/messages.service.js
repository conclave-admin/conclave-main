import {
  conversationMessageVisible,
  applyAccountClear,
} from "../lib/clearedConversations";
import {
  decryptMessage,
  decryptMessages,
  encryptEdit,
} from "../lib/encryption";
import { readRoomMessages } from "../lib/fileCache";
import { getSessionUserId } from "../lib/session";
import { api } from "../lib/api";
import {
  isDevAuthBypass,
  previewMessages,
  previewPinnedMessages,
  makePreviewLargeMessages,
} from "../config/devPreview";

async function decode(value) {
  if (Array.isArray(value)) return Promise.all(value.map(decode));
  if (value?.encrypted_payload) return decryptMessage(value);
  if (value?.messages)
    return { ...value, messages: await decryptMessages(value.messages) };
  return value;
}

let largePreviewMessages;
function previewHistory(roomId) {
  if (roomId !== "preview-large-room") return previewMessages;
  largePreviewMessages ||= makePreviewLargeMessages();
  return largePreviewMessages;
}

export async function listMessages(roomId, before, afterSeq, around) {
  if (isDevAuthBypass) {
    if (roomId === "preview-large-room") {
      const rows = previewHistory(roomId);
      const anchorIndex = around ? rows.findIndex((row) => row.id === around) : -1;
      if (around && anchorIndex < 0) throw new Error("Message no longer available");
      return {
        messages: around
          ? rows.slice(Math.max(0, anchorIndex - 100), anchorIndex + 101)
          : rows,
        nextCursor: null,
      };
    }
    const anchor = around
      ? previewMessages.find(
          (message) =>
            message.id === around && !message.is_deleted && !message.deleted_at,
        )
      : null;
    if (around && !anchor) throw new Error("Message no longer available");
    const rows = anchor
      ? previewMessages.slice(0, previewMessages.indexOf(anchor) + 1)
      : previewMessages;
    return {
      messages: [...rows].reverse().map((message) => ({
        ...message,
        room_id: roomId,
      })),
      nextCursor: null,
    };
  }
  const { data } = await api.get(`/messages/room/${roomId}`, {
    params: around
      ? { around, context: "viewport" }
      : afterSeq !== undefined
        ? { afterSeq }
        : before
          ? { before }
          : undefined,
  });
  return decode(data.data);
}

/**
 * Edit a message body.
 *
 * Author-only server-side, with no time limit. Mentions and attachments are
 * deliberately not editable — both are recorded facts about what was sent, and
 * letting an edit rewrite them would change who was notified after the fact.
 * A 403 from someone else's message is the server enforcing that, not a bug.
 */
export async function editMessage(messageId, content, message) {
  const body = message?.encrypted_payload
    ? { encryptedPayload: await encryptEdit(message, content) }
    : { content };
  const { data } = await api.patch(`/messages/${messageId}`, body);
  return decode(data.data);
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
  return decode(data.data);
}

/**
 * Add the caller's reaction.
 *
 * Idempotent — reacting twice does not stack, so this is safe to call from a
 * chip that is already lit.
 */
export async function addReaction(messageId, emoji) {
  const { data } = await api.put(`/messages/${messageId}/reactions`, { emoji });
  return decode(data.data);
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
  return decode(data.data);
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
export async function uploadFile(
  file,
  { onProgress, signal, filename, metadata } = {},
) {
  const form = new FormData();
  form.append("file", file, filename || file.name || "upload");
  if (metadata) form.append("mediaMetadata", JSON.stringify(metadata));
  const { data } = await api.post("/upload", form, {
    signal,
    onUploadProgress: (event) => {
      if (event.total) onProgress?.(event.loaded / event.total);
    },
  });
  return decode(data.data);
}

/**
 * Pin a message, in one of two scopes.
 *
 *   'room'  everyone in the room sees it, in the panel under the room header.
 *           At most one per message: a second person pinning gets a 409 naming
 *           who holds it, rather than silently taking it over.
 *   'user'  a personal bookmark nobody else is told about.
 *
 * PUT is idempotent for your own pin — a repeat updates pinned_at rather than
 * failing — which is why a double-tap on "Pin to room" is not a support ticket.
 */
export async function pinMessage(messageId, scope) {
  if (isDevAuthBypass)
    return { id: messageId, pins: { room: null, mine: [scope] } };
  const { data } = await api.put(`/messages/${messageId}/pin`, { scope });
  return decode(data.data);
}

/**
 * Remove a pin. Removing one that is not there succeeds with `unpinned: false`
 * rather than 404 — a retried request is not a failure.
 */
export async function unpinMessage(messageId, scope) {
  if (isDevAuthBypass) return { id: messageId, pins: { room: null, mine: [] } };
  const { data } = await api.delete(`/messages/${messageId}/pin/${scope}`);
  return decode(data.data);
}

/** Every room-wide pin in a room, oldest first. Personal bookmarks are not listed. */
export async function listPinnedMessages(roomId) {
  if (isDevAuthBypass) {
    if (roomId === "preview-large-room")
      return previewHistory(roomId)
        .filter((message) => message.id === "perf-300")
        .map((message) => ({
          ...message,
          pins: {
            room: {
              user_id: "dev-preview-user",
              display_name: "Amina Yusuf",
              pinned_at: message.created_at,
            },
            mine: [],
          },
        }));
    return previewPinnedMessages
      .filter((message) => message.room_id === roomId)
      .map((message) => ({ ...message, room_id: roomId }));
  }
  const { data } = await api.get(`/messages/room/${roomId}/pinned`);
  return decryptMessages(data.data.messages);
}

// Inspect only locally available history. While online, revalidate those IDs
// so information views cannot continue showing a deleted/cleared cached body.
export async function localConversationMessages(roomId) {
  const userId = getSessionUserId();
  let rows = await readRoomMessages(userId, roomId);
  if (getSessionUserId() !== userId) throw new Error("Account changed");
  if (navigator.onLine !== false && rows.length) {
    const { data } = await api.get(`/messages/room/${roomId}`, {
      params: {
        ids: rows
          .slice(-200)
          .map((m) => m.id)
          .join(","),
      },
    });
    rows = data.data.messages;
  }
  rows = await decryptMessages(rows);
  if (getSessionUserId() !== userId) throw new Error("Account changed");
  return rows.filter((m) => conversationMessageVisible(m, userId, roomId));
}

export async function listRoomMedia(
  roomId,
  { kind = "media", cursor, limit = 24, after, signal } = {},
) {
  if (!isDevAuthBypass) {
    const room = (await api.get(`/rooms/${roomId}`, { signal })).data.data;
    applyAccountClear(
      getSessionUserId(),
      roomId,
      room.cleared_sequence,
      room.cleared_at,
    );
    if (room.encryption_mode === "e2ee-v1") {
      const messages = await localConversationMessages(roomId);
      const files = messages
        .filter(
          (m) =>
            m._decrypted &&
            conversationMessageVisible(m, getSessionUserId(), roomId) &&
            !m.is_deleted &&
            !m.deleted_at &&
            (!after || new Date(m.created_at) > new Date(after)),
        )
        .flatMap((m) =>
          (m.attachments || []).map((a) => ({
            ...a,
            message_id: m.id,
            created_at: m.created_at,
            sender_name: m.sender_name,
          })),
        )
        .filter((a) =>
          kind === "media"
            ? /^(image|video)\//.test(a.mime_type || "")
            : kind === "audio"
              ? (a.mime_type || "").startsWith("audio/")
              : !/^(image|video|audio)\//.test(a.mime_type || ""),
        )
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const start = cursor ? Number(cursor) : 0;
      return {
        media: files.slice(start, start + limit),
        nextCursor: start + limit < files.length ? String(start + limit) : null,
        localOnly: true,
      };
    }
  }
  if (isDevAuthBypass) {
    const rows = previewMessages
      .filter(
        (message) =>
          !message.is_deleted &&
          !message.deleted_at &&
          (!after || new Date(message.created_at) > new Date(after)),
      )
      .flatMap((message) =>
        (message.attachments || []).map((item, index) => ({
          ...item,
          id: item.id || `${message.id}-file-${index}`,
          message_id: message.id,
          created_at: message.created_at,
          sender_name: message.sender_name,
        })),
      )
      .filter((item) => {
        const type = item.mime_type || "";
        return kind === "media"
          ? /^(image|video)\//.test(type)
          : kind === "audio"
            ? type.startsWith("audio/")
            : !/^(image|video|audio)\//.test(type);
      })
      .reverse();
    const start = cursor ? Number(cursor) : 0;
    return {
      media: rows.slice(start, start + limit),
      nextCursor: start + limit < rows.length ? String(start + limit) : null,
    };
  }
  const { data } = await api.get(`/messages/room/${roomId}/media`, {
    params: { kind, cursor, limit, after },
    signal,
    timeout: 20000,
  });
  return decode(data.data);
}

export async function getMessageReceipts(messageId) {
  if (isDevAuthBypass)
    return {
      messageId,
      sentAt: previewMessages.find((m) => m.id === messageId)?.created_at,
      summary: {
        history_complete: false,
        recipient_count: 1,
        delivered_count: 0,
        read_count: 0,
      },
      recipients: [
        {
          user_id: "dev-victor",
          display_name: "Victor",
          delivered: false,
          read: false,
          current_member: true,
        },
      ],
    };
  const { data } = await api.get(`/messages/${messageId}/receipts`);
  return decode(data.data);
}

export async function getRoomReceiptSummaries(roomId, ids) {
  if (isDevAuthBypass) return { roomId, receipts: [] };
  const { data } = await api.get(`/messages/room/${roomId}/receipts`, {
    params: { ids: ids.join(",") },
  });
  return decode(data.data);
}

export async function getMessageSnapshots(roomId, ids) {
  if (isDevAuthBypass) {
    const messages = previewHistory(roomId)
      .filter((m) => ids.includes(m.id))
      .map((m) => ({ ...m, room_id: roomId }));
    return {
      messages,
      missingIds: ids.filter((id) => !messages.some((m) => m.id === id)),
    };
  }
  return decode(
    (
      await api.get(`/messages/room/${roomId}`, {
        params: { ids: ids.join(",") },
      })
    ).data.data,
  );
}
