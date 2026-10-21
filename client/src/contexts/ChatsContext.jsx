import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { listRooms, markRoomSeen, updateRoomPreferences } from '@/services/rooms.service';
import { useRealtime } from './RealtimeContext';
import { useAuth } from './AuthContext';
import { readChatList, saveChatList } from '../lib/fileCache';

const ChatsContext = createContext(null);

/**
 * The chat list's state: rooms, unread totals, and the locally-stored pin and
 * mute sets.
 *
 * This exists rather than a `useRooms` hook that fetches on mount, because the
 * list has to be shared and it has to stay current. The sidebar, the bottom
 * tab bar and the header badge all need the same unread total, and `chat:updated`
 * has to land in one place or three copies of the count drift apart — which is
 * the exact bug phase 1 avoided on the server by computing unread_count and the
 * event payload from one SQL string.
 *
 * Ordering is pinned-first, then by recency, computed here rather than in the
 * component: two surfaces rendering the same rooms in two different orders
 * would read as two different workspaces.
 *
 * @param {React.ReactNode} children
 */
export function ChatsProvider({ children }) {
  const { socket } = useRealtime();
  const { user } = useAuth();
  const userId = user?.id;
  const [rooms, setRooms] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [pinned, setPinned] = useState([]);
  const [muted, setMuted] = useState([]);
  const [archived, setArchived] = useState([]);
  const [typingByRoom, setTypingByRoom] = useState(new Map());
  const typingTimers = useRef(new Map());

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError('');
    const apply = (loaded) => {
      setRooms(loaded);
      setPinned(loaded.filter((room) => room.is_pinned).map((room) => room.id));
      setMuted(loaded.filter((room) => room.is_muted).map((room) => room.id));
      setArchived(loaded.filter((room) => room.is_archived).map((room) => room.id));
    };
    const cached = await readChatList(userId);
    if (cached.length) { apply(cached); setIsLoading(false); }
    if (navigator.onLine === false) {
      if (!cached.length) setError('No conversations have been saved on this device yet.');
      setIsLoading(false);
      return;
    }
    try {
      const loaded = await listRooms();
      apply(loaded);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load chats.');
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, [refresh]);

  useEffect(() => {
    if (rooms.length) saveChatList(userId, rooms);
  }, [userId, rooms]);

  // Phase 1 emits this after every message create, edit and delete, to each
  // member's personal channel. The client was not listening to it at all until
  // now, which meant the sidebar only changed on a full reload.
  useEffect(() => {
    if (!socket) return undefined;

    const onChatUpdated = ({ roomId, lastMessage, unreadCount }) => {
      setRooms((current) =>
        current.map((room) =>
          room.id === roomId
            ? { ...room, last_message: lastMessage, unread_count: unreadCount, has_message: true }
            : room,
        ),
      );
    };

    const onTyping = ({ roomId, userId }) => {
      const key = `${roomId}:${userId}`;
      clearTimeout(typingTimers.current.get(key));
      typingTimers.current.set(key, setTimeout(() => {
        setTypingByRoom((rows) => {
          const next = new Map(rows);
          const ids = new Set(next.get(roomId) || []);
          ids.delete(userId);
          next.set(roomId, ids);
          return next;
        });
        typingTimers.current.delete(key);
      }, 6000));
      setTypingByRoom((current) => {
      const next = new Map(current);
      next.set(roomId, new Set([...(next.get(roomId) || []), userId]));
      return next;
      });
    };
    const onStopTyping = ({ roomId, userId }) => {
      const key = `${roomId}:${userId}`;
      clearTimeout(typingTimers.current.get(key));
      typingTimers.current.delete(key);
      setTypingByRoom((current) => {
      const next = new Map(current);
      const ids = new Set(next.get(roomId) || []);
      ids.delete(userId);
      next.set(roomId, ids);
      return next;
      });
    };
    const onRoomTyping = ({ roomId, typingUserIds }) => setTypingByRoom((current) => new Map(current).set(roomId, new Set(typingUserIds || [])));

    socket.on('chat:updated', onChatUpdated);
    socket.on('typing', onTyping);
    socket.on('stop-typing', onStopTyping);
    socket.on('room-typing', onRoomTyping);
    return () => {
      socket.off('chat:updated', onChatUpdated);
      socket.off('typing', onTyping);
      socket.off('stop-typing', onStopTyping);
      socket.off('room-typing', onRoomTyping);
      typingTimers.current.forEach((timer) => clearTimeout(timer));
      typingTimers.current.clear();
    };
  }, [socket]);

  /**
   * Mark a room read, optimistically.
   *
   * The badge clears before the request completes because the alternative is
   * a visible re-count on every room you open, and because the server's
   * answer is not in doubt — it is the same call the old client already made.
   * A failure restores the list rather than leaving a badge that says zero for
   * a room the server still considers unread.
   */
  const markSeen = useCallback(
    async (roomId) => {
      setRooms((current) =>
        current.map((room) => (room.id === roomId ? { ...room, unread_count: 0 } : room)),
      );
      try {
        await markRoomSeen(roomId);
      } catch {
        refresh();
      }
    },
    [refresh],
  );

  const togglePreference = useCallback(async (roomId, key, setter, current) => {
    const value = !current.includes(roomId);
    setter((rows) => value ? [...rows, roomId] : rows.filter((id) => id !== roomId));
    try {
      await updateRoomPreferences(roomId, { [key]: value });
      setRooms((rows) => rows.map((room) => room.id === roomId ? { ...room, [`is_${key}`]: value } : room));
    } catch { refresh(); }
  }, [refresh]);

  const togglePin = useCallback((roomId) => togglePreference(roomId, 'pinned', setPinned, pinned), [togglePreference, pinned]);

  const toggleMute = useCallback((roomId) => togglePreference(roomId, 'muted', setMuted, muted), [togglePreference, muted]);
  const toggleArchive = useCallback((roomId) => togglePreference(roomId, 'archived', setArchived, archived), [togglePreference, archived]);

  const sortedRooms = useMemo(() => {
    const recency = (room) => room.last_message?.created_at || '';
    return [...rooms].sort((a, b) => {
      const aPinned = pinned.includes(a.id);
      const bPinned = pinned.includes(b.id);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return recency(b).localeCompare(recency(a));
    });
  }, [rooms, pinned]);

  /**
   * Unread total for the rail, the tab bar and the header badge.
   *
   * Muted rooms are excluded. A row already hides its own badge when muted, so
   * counting them here would mean muting a room and watching the total stay
   * put — mute would look like it did nothing. One definition of "muted" has
   * to hold across all four surfaces or the control is lying.
   */
  const unreadTotal = useMemo(
    () =>
      rooms.reduce(
        (total, room) =>
          total + (muted.includes(room.id) ? 0 : room.unread_count || 0),
        0,
      ),
    [rooms, muted],
  );

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (unreadTotal > 0) navigator.setAppBadge?.(unreadTotal).catch?.(() => {});
    else navigator.clearAppBadge?.().catch?.(() => {});
  }, [unreadTotal]);

  const value = useMemo(
    () => ({
      rooms: sortedRooms,
      archivedRooms: rooms.filter((room) => archived.includes(room.id)),
      isLoading,
      error,
      unreadTotal,
      pinned,
      muted,
      archived,
      typingByRoom,
      refresh,
      markSeen,
      togglePin,
      toggleMute,
      toggleArchive,
    }),
    [sortedRooms, rooms, archived, typingByRoom, isLoading, error, unreadTotal, pinned, muted, refresh, markSeen, togglePin, toggleMute, toggleArchive],
  );

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}

export function useChats() {
  const value = useContext(ChatsContext);
  if (!value) throw new Error('useChats must be used inside ChatsProvider');
  return value;
}
