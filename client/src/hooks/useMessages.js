import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime } from '../contexts/RealtimeContext';
import {
  addReaction as addReactionApi,
  deleteMessage as deleteMessageApi,
  editMessage as editMessageApi,
  listMessages,
  removeReaction as removeReactionApi,
} from '../services/messages.service';

const PAGE_SIZE = 50;

// How long a typing indicator survives without a fresh `typing` event. The
// server expires them in Redis but emits nothing when it does, so a client that
// trusted the last event alone would show someone typing forever after their
// network dropped. This is the belt to that suspenders.
const TYPING_TIMEOUT_MS = 6000;

function byTime(a, b) {
  return new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id));
}

function mergeMessages(current, rows) {
  const merged = new Map(current.map((message) => [message.id, message]));
  rows.forEach((message) => merged.set(message.id, message));
  return [...merged.values()].sort(byTime);
}

let tempId = 0;
const nextTempId = () => `optimistic-${Date.now()}-${tempId++}`;

/**
 * One room's timeline: history, live updates, delivery state and read
 * pointers.
 *
 * Sending goes over the socket, not `POST /messages`. Both write through the
 * same service, but only the socket handler emits `receive-message` — a REST
 * send updates everyone's sidebar via `chat:updated` and leaves the open
 * conversation stale for every other member. So the socket is not an
 * optimisation here, it is the only path that delivers.
 *
 * Because the echo comes back through the room rather than as an
 * acknowledgement, an optimistic row is inserted on send and withdrawn when the
 * real one arrives, matched on sender and content. That match is imperfect —
 * sending the identical text twice in a row can withdraw the wrong row — but
 * the alternative is a composer that appears to do nothing for the round trip,
 * which is worse and is the failure people actually report.
 *
 * @param {string|null} roomId
 * @param {Array} roomMembers - from `GET /rooms/:roomId`, seeds the read pointers
 */
export default function useMessages(roomId, roomMembers = []) {
  const { socket } = useRealtime();
  const { user } = useAuth();
  const viewerId = user?.id;

  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [typingUserIds, setTypingUserIds] = useState([]);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [failedIds, setFailedIds] = useState(() => new Set());
  const [readPointers, setReadPointers] = useState(() => new Map());

  const typingTimers = useRef(new Map());

  // --- history ---------------------------------------------------------------
  useEffect(() => {
    let active = true;
    if (!roomId) {
      setMessages([]);
      setIsLoading(false);
      return undefined;
    }
    setIsLoading(true);
    setError('');
    setMessages([]);
    setNextCursor(null);

    listMessages(roomId)
      .then(({ messages: rows, nextCursor: cursor }) => {
        if (!active) return;
        setMessages(mergeMessages([], rows));
        setNextCursor(cursor);
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || 'Could not load messages.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [roomId]);

  // --- read pointers ---------------------------------------------------------
  // Seeded from the room's member list, which already carries each member's
  // last_seen_at. Socket updates advance that map in place; nothing re-fetches.
  useEffect(() => {
    setReadPointers(() => {
      const map = new Map();
      (roomMembers || []).forEach((member) => {
        if (member?.id) map.set(member.id, member.last_seen_at);
      });
      return map;
    });
  }, [roomMembers]);

  // --- live ------------------------------------------------------------------
  useEffect(() => {
    if (!socket || !roomId) return undefined;

    const join = () => socket.emit('join-room', { roomId });

    const receive = ({ message }) => {
      if (message.room_id !== roomId) return;
      setMessages((current) => {
        let next = current;
        // Withdraw the optimistic row this one is the acknowledgement of.
        if (message.sender_id === viewerId) {
          const index = current.findIndex(
            (item) => item._optimistic && item.content === message.content,
          );
          if (index !== -1) {
            const withdrawn = current[index];
            next = current.filter((_, i) => i !== index);
            setPendingIds((prev) => {
              const copy = new Set(prev);
              copy.delete(withdrawn.id);
              return copy;
            });
          }
        }
        if (next.some((item) => item.id === message.id)) return next;
        return [...next, message].sort(byTime);
      });
    };

    // Each of these carries the whole message, so the copy in state is replaced
    // rather than patched. That is the server's design: it re-reads the row
    // through one serializer for edit, delete and reaction alike, so a client
    // that trusts the payload cannot end up with three slightly different
    // message shapes.
    const replaceMessage = (message) => {
      if (message.room_id !== roomId) return;
      setMessages((current) =>
        current.some((item) => item.id === message.id)
          ? current.map((item) => (item.id === message.id ? message : item))
          : [...current, message].sort(byTime),
      );
    };

    const onTyping = ({ roomId: eventRoom, userId }) => {
      if (eventRoom !== roomId || userId === viewerId) return;
      clearTimeout(typingTimers.current.get(userId));
      typingTimers.current.set(
        userId,
        setTimeout(() => {
          setTypingUserIds((prev) => prev.filter((id) => id !== userId));
        }, TYPING_TIMEOUT_MS),
      );
      setTypingUserIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    };

    const onStopTyping = ({ roomId: eventRoom, userId }) => {
      if (eventRoom !== roomId) return;
      clearTimeout(typingTimers.current.get(userId));
      setTypingUserIds((prev) => prev.filter((id) => id !== userId));
    };

    const onRoomTyping = ({ roomId: eventRoom, typingUserIds: ids }) => {
      if (eventRoom !== roomId) return;
      setTypingUserIds((ids || []).filter((id) => id !== viewerId));
    };

    // A read pointer is a room-level fact about a member, not about one message,
    // so both events write the same map. The message id on `message-read` is
    // only there so a client can highlight the row that triggered it.
    const onReadPointer = ({ roomId: eventRoom, userId, lastSeenAt }) => {
      if (eventRoom !== roomId || !lastSeenAt) return;
      setReadPointers((prev) => {
        const next = new Map(prev);
        const existing = next.get(userId);
        // Never move a pointer backwards: overlapping events can arrive out of
        // order, and a tick that flickers back to unread is worse than one that
        // is a moment late.
        if (existing && new Date(existing) >= new Date(lastSeenAt)) return prev;
        next.set(userId, lastSeenAt);
        return next;
      });
    };

    const onError = () => {
      // The server emits `error:message` without naming which send failed, so
      // the oldest unacknowledged row is the one that timed out — a later send
      // cannot have failed before an earlier one was rejected.
      setPendingIds((pending) => {
        const oldest = [...pending][0];
        if (!oldest) return pending;
        const rest = new Set(pending);
        rest.delete(oldest);
        // Failed rather than pending: it is never coming back, and leaving it
        // pending would spin forever with no way for the reader to tell.
        setFailedIds((prev) => new Set(prev).add(oldest));
        return rest;
      });
    };

    socket.on('connect', join);
    socket.on('receive-message', receive);
    socket.on('message:updated', replaceMessage);
    socket.on('message:deleted', replaceMessage);
    socket.on('message:reaction', replaceMessage);
    socket.on('typing', onTyping);
    socket.on('stop-typing', onStopTyping);
    socket.on('room-typing', onRoomTyping);
    socket.on('message-read', onReadPointer);
    socket.on('room-seen', onReadPointer);
    socket.on('error:message', onError);

    if (socket.connected) join();

    return () => {
      typingTimers.current.forEach((timer) => clearTimeout(timer));
      typingTimers.current.clear();
      socket.off('connect', join);
      socket.off('receive-message', receive);
      socket.off('message:updated', replaceMessage);
      socket.off('message:deleted', replaceMessage);
      socket.off('message:reaction', replaceMessage);
      socket.off('typing', onTyping);
      socket.off('stop-typing', onStopTyping);
      socket.off('room-typing', onRoomTyping);
      socket.off('message-read', onReadPointer);
      socket.off('room-seen', onReadPointer);
      socket.off('error:message', onError);
      if (socket.connected) socket.emit('leave-room', { roomId });
    };
  }, [roomId, socket, viewerId]);

  // --- actions ---------------------------------------------------------------

  /**
   * Send, optimistically.
   *
   * `attachments` and `mentionedUserIds` are only meaningful on the socket
   * payload as well as the REST body — the socket handler forwards both to the
   * same createMessage call, so omitting them here would silently drop a file
   * or fall back to inferring mentions from display names.
   */
  const sendMessage = useCallback(
    ({ content, replyToId, attachments, mentionedUserIds } = {}) => {
      if (!socket?.connected) {
        throw new Error('Realtime connection is unavailable.');
      }
      const text = (content || '').trim();
      if (!text && !(attachments && attachments.length)) return;

      const id = nextTempId();
      setPendingIds((prev) => new Set(prev).add(id));
      setFailedIds((prev) => {
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      });
      setMessages((current) =>
        [
          ...current,
          {
            id,
            room_id: roomId,
            sender_id: viewerId,
            sender_name: user?.display_name || 'You',
            content: text,
            reply_to_id: replyToId || null,
            attachments: attachments || [],
            reactions: [],
            mentioned_user_ids: mentionedUserIds || [],
            created_at: new Date().toISOString(),
            _optimistic: true,
          },
        ].sort(byTime),
      );

      socket.emit('send-message', {
        roomId,
        content: text,
        replyToId,
        attachments,
        mentionedUserIds,
      });
      // No `typing` emit here. Sending clears the sender's typing state on the
      // server, so announcing one would put them back on the list the moment
      // they stopped.
    },
    [roomId, socket, user, viewerId],
  );

  const stopTyping = useCallback(() => {
    if (socket?.connected) socket.emit('stop-typing', { roomId });
  }, [roomId, socket]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || isLoadingOlder || !roomId) return;
    setIsLoadingOlder(true);
    try {
      const { messages: rows, nextCursor: cursor } = await listMessages(roomId, nextCursor);
      // Prepend without re-sorting the whole list: the cursor walks backwards in
      // time, so older rows always sort before everything already held.
      setMessages((current) => {
        const known = new Set(current.map((m) => m.id));
        const older = rows.filter((m) => !known.has(m.id));
        return [...older, ...current];
      });
      setNextCursor(cursor);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load earlier messages.');
    } finally {
      setIsLoadingOlder(false);
    }
  }, [nextCursor, isLoadingOlder, roomId]);

  const editMessage = useCallback(async (messageId, content) => {
    const updated = await editMessageApi(messageId, content);
    setMessages((current) => current.map((m) => (m.id === messageId ? updated : m)));
    return updated;
  }, []);

  const removeMessage = useCallback(async (messageId) => {
    const tombstone = await deleteMessageApi(messageId);
    setMessages((current) => current.map((m) => (m.id === messageId ? tombstone : m)));
    return tombstone;
  }, []);

  const toggleReaction = useCallback(
    async (message, emoji) => {
      const mine = (message.reactions || []).find((r) => r.emoji === emoji)?.reacted;
      const updated = mine
        ? await removeReactionApi(message.id, emoji)
        : await addReactionApi(message.id, emoji);
      setMessages((current) => current.map((m) => (m.id === message.id ? updated : m)));
      return updated;
    },
    [],
  );

  const deliveryIds = useMemo(() => ({ pendingIds, failedIds }), [pendingIds, failedIds]);

  return {
    messages,
    isLoading,
    error,
    hasMore: Boolean(nextCursor),
    isLoadingOlder,
    loadOlder,
    sendMessage,
    stopTyping,
    editMessage,
    removeMessage,
    toggleReaction,
    typingUserIds,
    readPointers,
    deliveryIds,
  };
}
