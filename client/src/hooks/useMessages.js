import { getRoomReceiptSummaries } from '../services/messages.service';
import { newerReceipt } from '../lib/messageMeta';
import { usePresence } from '../contexts/PresenceContext';
import { subscribeToRoom } from '../lib/roomSubscriptions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getConversationClearTime } from '../lib/clearedConversations';
import { useRealtime } from '../contexts/RealtimeContext';
import { readRoomMessages, saveRoomMessages } from '../lib/fileCache';
import { useOutbox } from '../contexts/OutboxContext';
import { draftMessage } from '../lib/outbox';
import {
  addReaction as addReactionApi,
  deleteMessage as deleteMessageApi,
  editMessage as editMessageApi,
  listMessages,
  pinMessage as pinMessageApi,
  removeReaction as removeReactionApi,
  unpinMessage as unpinMessageApi,
} from '../services/messages.service';

function byTime(a, b) {
  if (a.room_sequence != null && b.room_sequence != null) return Number(a.room_sequence) - Number(b.room_sequence);
  return new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id));
}

function mergeMessages(current, rows) {
  const merged = new Map(current.map((message) => [message.id, message]));
  rows.forEach((message) => merged.set(message.id, { ...message, receipt_summary: newerReceipt(merged.get(message.id)?.receipt_summary, message.receipt_summary) }));
  return [...merged.values()].sort(byTime);
}

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
 * Pending messages come from the account-level outbox. They are matched to
 * saved messages by client_id, including history fetched after a reconnect.
 *
 * @param {string|null} roomId
 * @param {Array} roomMembers - from `GET /rooms/:roomId`, seeds the read pointers
 */
export default function useMessages(roomId, roomMembers = [], anchorId = null) {
  const { socket } = useRealtime();
  const { user } = useAuth();
  const viewerId = user?.id;
  const outbox = useOutbox();

  const [messages, setMessages] = useState([]);
  const [receiptUpdates, setReceiptUpdates] = useState(() => new Map());
  const [clearedAt, setClearedAt] = useState(() => getConversationClearTime(viewerId, roomId));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const { getActivity } = usePresence();
  const { typingUserIds, recordingUserIds } = getActivity(roomId);
  const [readPointers, setReadPointers] = useState(() => new Map());
  const [readSequences, setReadSequences] = useState(() => new Map());
  const [deliveredSequences, setDeliveredSequences] = useState(() => new Map());
  const [lastSeenSequence, setLastSeenSequence] = useState(0);
  const historyVersion = useRef(0);
  const historyReady = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    setClearedAt(getConversationClearTime(viewerId, roomId));
    const onCleared = (event) => {
      if (event.detail?.userId === viewerId && event.detail?.roomId === roomId) setClearedAt(event.detail.clearedAt);
    };
    window.addEventListener('conclave:conversation-cleared', onCleared);
    return () => window.removeEventListener('conclave:conversation-cleared', onCleared);
  }, [viewerId, roomId]);


  // --- history ---------------------------------------------------------------
  useEffect(() => {
    let active = true;
    historyVersion.current += 1;
    setReceiptUpdates(new Map());
    historyReady.current = false;
    setIsLoadingOlder(false);
    if (!roomId) {
      setMessages([]);
      setIsLoading(false);
      return undefined;
    }
    setIsLoading(true);
    setError('');
    setMessages([]);
    setNextCursor(null);
    if (!anchorId) readRoomMessages(viewerId, roomId).then((cached) => {
      if (active && cached.length) {
        setMessages((current) => mergeMessages(current, cached));
        setIsLoading(false);
      }
    });
    listMessages(roomId, undefined, undefined, anchorId)
      .then(({ messages: rows, nextCursor: cursor }) => {
        if (!active) return;
        if (anchorId) {
          const target = rows.find((row) => row.id === anchorId);
          if (target && new Date(target.created_at).getTime() <= getConversationClearTime(viewerId, roomId)) throw new Error('This message was cleared on this device.');
        }
        setMessages((current) => mergeMessages(current, rows));
        setNextCursor(cursor);
        if (!anchorId) saveRoomMessages(viewerId, roomId, rows);
        if (socket?.connected) rows.filter((message) => message.sender_id !== viewerId).forEach((message) => socket.emit('message-delivered', { roomId, messageId: message.id }));
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || err.message || 'Could not load messages.');
      })
      .finally(() => {
        if (active) { historyReady.current = true; setIsLoading(false); }
      });

    return () => {
      active = false;
    };
  }, [roomId, viewerId, user?.display_name, socket, anchorId]);

  useEffect(() => {
    if (!anchorId && messages.length) saveRoomMessages(viewerId, roomId, messages.map(message => ({ ...message, receipt_summary: newerReceipt(message.receipt_summary, receiptUpdates.get(message.id)) })));
  }, [messages, roomId, viewerId, anchorId, receiptUpdates]);

  // --- read pointers ---------------------------------------------------------
  // Seeded from the room's member list, which already carries each member's
  // last_seen_at. Socket updates advance that map in place; nothing re-fetches.
  useEffect(() => {
    const map = new Map();
    const sequences = new Map();
    const delivered = new Map();
    (roomMembers || []).forEach((member) => {
      if (member?.id) {
        map.set(member.id, member.last_seen_at);
        sequences.set(member.id, Number(member.last_seen_sequence) || 0);
        delivered.set(member.id, Number(member.last_delivered_sequence) || 0);
      }
    });
    setReadPointers(map);
    setReadSequences(sequences);
    setDeliveredSequences(delivered);
    const own = (roomMembers || []).find((member) => member?.id === viewerId);
    setLastSeenSequence(Number(own?.last_seen_sequence) || 0);
  }, [roomMembers, viewerId]);

  // --- live ------------------------------------------------------------------
  useEffect(() => {
    if (!socket || !roomId) return undefined;
    let active = true;
    const fillGap = async () => {
      if (!historyReady.current) return;
      try {
        const received = [];
        if (!anchorId) {
          let sequence = Math.max(0, ...messagesRef.current.map(item => Number(item.room_sequence) || 0));
          let missing;
          do {
            ({ messages: missing } = await listMessages(roomId, undefined, sequence));
            if (!active) return;
            received.push(...missing);
            if (missing.length) {
              const page = missing;
              setMessages(current => mergeMessages(current, page));
              sequence = Math.max(sequence, ...missing.map(item => Number(item.room_sequence) || 0));
            }
          } while (missing.length === 200);
        }
        const loaded = mergeMessages(messagesRef.current, received).filter(message => !message._optimistic);
        // A previous delivery ack may have been lost after the bytes were
        // cached. Retransmit it, including on anchored historical timelines.
        loaded.filter(message => message.sender_id !== viewerId).forEach(message => socket.emit('message-delivered', { roomId, messageId: message.id }));
        const ids = loaded.map(message => message.id);
        for (let offset = 0; offset < ids.length; offset += 200) {
          const snapshot = await getRoomReceiptSummaries(roomId, ids.slice(offset, offset + 200));
          if (!active) return;
          onReceipts(snapshot);
        }
      } catch { /* reconnect will retry on the next connect */ }
    };
    const unsubscribe = subscribeToRoom(socket, roomId);
    const join = () => { fillGap(); };

    const receive = ({ message }) => {
      if (message.room_id !== roomId) return;
      if (message.sender_id !== viewerId && socket.connected) socket.emit('message-delivered', { roomId, messageId: message.id });
      if (!anchorId || messagesRef.current.some((row) => row.id === message.id)) setMessages((current) => mergeMessages(current, [message]));
    };

    const onDelivered = ({ roomId: eventRoom, userId, lastDeliveredSequence }) => {
      if (eventRoom !== roomId || lastDeliveredSequence == null) return;
      setDeliveredSequences((prev) => {
        const next = new Map(prev);
        next.set(userId, Math.max(next.get(userId) || 0, Number(lastDeliveredSequence) || 0));
        return next;
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

    const onPinChanged = ({ message }) => replaceMessage(message);

    // Only the poll is replaced, so this viewer's own reaction and pin flags on
    // the message are left alone — which is the whole reason `poll:updated`
    // does not ship the message alongside it.
    const onPollUpdated = ({ messageId, roomId: eventRoom, poll }) => {
      if (eventRoom !== roomId) return;
      setMessages((current) =>
        current.map((item) => (item.id === messageId ? { ...item, poll } : item)),
      );
    };

    // A read pointer is a room-level fact about a member, not about one message,
    // so both events write the same map. The message id on `message-read` is
    // only there so a client can highlight the row that triggered it.
    const onReadPointer = ({ roomId: eventRoom, userId, lastSeenAt, lastSeenSequence: sequence }) => {
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
      if (sequence != null) setReadSequences((prev) => {
        const next = new Map(prev);
        next.set(userId, Math.max(next.get(userId) || 0, Number(sequence) || 0));
        return next;
      });
      if (userId === viewerId && sequence != null) setLastSeenSequence((value) => Math.max(value, Number(sequence) || 0));
    };

    const onReceipts = ({ roomId: eventRoom, receipts = [] }) => {
      if (eventRoom !== roomId) return;
      setReceiptUpdates(previous => {
        const next = new Map(previous);
        for (const entry of receipts) next.set(entry.messageId, newerReceipt(next.get(entry.messageId), entry.receipt_summary));
        return next;
      });
    };
    socket.on('message:receipts', onReceipts);
    socket.on('connect', join);
    socket.on('receive-message', receive);
    socket.on('message-delivered', onDelivered);
    socket.on('message:updated', replaceMessage);
    socket.on('message:deleted', replaceMessage);
    socket.on('message:reaction', replaceMessage);
    // Pins ride the same replace-the-row shape as reactions and edits: the
    // payload is the message as it now is, pins included, so the menu labels
    // below update without a refetch.
    socket.on('message:pinned', onPinChanged);
    socket.on('message:unpinned', onPinChanged);
    socket.on('poll:updated', onPollUpdated);
    socket.on('message-read', onReadPointer);
    socket.on('room-seen', onReadPointer);

    if (socket.connected) join();

    return () => {
      active = false;
      socket.off('message:receipts', onReceipts);
      socket.off('connect', join);
      socket.off('receive-message', receive);
      socket.off('message-delivered', onDelivered);
      socket.off('message:updated', replaceMessage);
      socket.off('message:deleted', replaceMessage);
      socket.off('message:reaction', replaceMessage);
      socket.off('message:pinned', onPinChanged);
      socket.off('message:unpinned', onPinChanged);
      socket.off('poll:updated', onPollUpdated);
      socket.off('message-read', onReadPointer);
      socket.off('room-seen', onReadPointer);
      unsubscribe();
    };
  }, [roomId, socket, viewerId, anchorId]);

  // --- actions ---------------------------------------------------------------

  // Persist before reporting success to the composer. Uploads and delivery
  // continue in OutboxProvider even after this room unmounts.
  const sendMessage = useCallback(
    ({ content, replyToId, attachments = [], albumId, mentionedUserIds = [] } = {}) => {
      const text = (content || '').trim();
      if (!text && !attachments.length) return Promise.resolve();
      return outbox.enqueue(roomId, [{ content: text, replyToId, attachments, albumId, mentionedUserIds }]);
    },
    [roomId, outbox.enqueue],
  );
  const sendMedia = useCallback((items) => outbox.enqueue(roomId, items), [roomId, outbox.enqueue]);

  useEffect(() => {
    const sent = (event) => {
      if (event.detail?.userId !== viewerId || event.detail.message.room_id !== roomId) return;
      setMessages((current) => mergeMessages(current, [event.detail.message]));
    };
    window.addEventListener('conclave:outbox-sent', sent);
    return () => window.removeEventListener('conclave:outbox-sent', sent);
  }, [roomId, viewerId]);

  const stopTyping = useCallback(() => {
    if (socket?.connected) socket.emit('stop-typing', { roomId });
  }, [roomId, socket]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || isLoadingOlder || !roomId) return;
    const version = historyVersion.current;
    setIsLoadingOlder(true);
    setError('');
    try {
      const { messages: rows, nextCursor: cursor } = await listMessages(roomId, nextCursor);
      if (historyVersion.current !== version) return;
      // Prepend without re-sorting the whole list: the cursor walks backwards in
      // time, so older rows always sort before everything already held.
      setMessages((current) => {
        const known = new Set(current.map((m) => m.id));
        const older = rows.filter((m) => !known.has(m.id));
        return mergeMessages(current, older);
      });
      setNextCursor(cursor);
    } catch (err) {
      if (historyVersion.current === version) setError(err.response?.data?.message || 'Could not load earlier messages.');
    } finally {
      if (historyVersion.current === version) setIsLoadingOlder(false);
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

  const roomDrafts = useMemo(() => outbox.entries.filter((item) => item.roomId === roomId), [outbox.entries, roomId]);
  const deliveryIds = useMemo(() => ({
    pendingIds: new Set(roomDrafts.filter((item) => ['uploading', 'awaiting_ack'].includes(item.state)).map((item) => item.tempId)),
    queuedIds: new Set(roomDrafts.filter((item) => item.state === 'queued').map((item) => item.tempId)),
    failedIds: new Set(roomDrafts.filter((item) => item.state === 'failed').map((item) => item.tempId)),
    onRetry: outbox.retry, onCancel: outbox.cancel,
  }), [roomDrafts, outbox.retry, outbox.cancel]);
  const visibleMessages = useMemo(() => {
    const known = new Set(messages.map((message) => message.client_id).filter(Boolean));
    const pending = roomDrafts.filter((item) => !known.has(item.clientId)).map((item) => draftMessage(item, user?.display_name));
    return mergeMessages(messages.filter((message) => !message._optimistic), pending)
      .filter((message) => new Date(message.created_at).getTime() > clearedAt)
      .map(message => ({ ...message, receipt_summary: newerReceipt(message.receipt_summary, receiptUpdates.get(message.id)) }));
  }, [messages, roomDrafts, clearedAt, user?.display_name, receiptUpdates]);

  // Both scopes. The panel and the message menu call these same two functions,
  // so a pin started in one place behaves identically to one started in the
  // other. The socket events do the timeline update, so neither applies
  // optimistically — a 409 (somebody else holds the room pin) is shown as an
  // error rather than as a pin that silently fails.
  const pinMessage = (messageId, scope) => pinMessageApi(messageId, scope);
  const unpinMessage = (messageId, scope) => unpinMessageApi(messageId, scope);

  return {
    messages: visibleMessages,
    isLoading: isLoading && !visibleMessages.length,
    error,
    hasMore: Boolean(nextCursor),
    isLoadingOlder,
    loadOlder,
    sendMessage,
    sendMedia,
    stopTyping,
    editMessage,
    removeMessage,
    toggleReaction,
    pinMessage,
    unpinMessage,
    typingUserIds,
    recordingUserIds,
    readPointers,
    readSequences,
    deliveredSequences,
    lastSeenSequence,
    deliveryIds,
  };
}
