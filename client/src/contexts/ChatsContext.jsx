import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { MUTED_ROOMS_KEY, PINNED_ROOMS_KEY, readIdList, toggleId, writeIdList } from '@/lib/localRoomPrefs';
import { listRooms, markRoomSeen } from '@/services/rooms.service';
import { useRealtime } from './RealtimeContext';

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
  const [rooms, setRooms] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [pinned, setPinned] = useState(() => readIdList(PINNED_ROOMS_KEY));
  const [muted, setMuted] = useState(() => readIdList(MUTED_ROOMS_KEY));

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      setRooms(await listRooms());
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load chats.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

    socket.on('chat:updated', onChatUpdated);
    return () => socket.off('chat:updated', onChatUpdated);
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

  const togglePin = useCallback((roomId) => {
    setPinned((current) => {
      const next = toggleId(current, roomId);
      writeIdList(PINNED_ROOMS_KEY, next);
      return next;
    });
  }, []);

  const toggleMute = useCallback((roomId) => {
    setMuted((current) => {
      const next = toggleId(current, roomId);
      writeIdList(MUTED_ROOMS_KEY, next);
      return next;
    });
  }, []);

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

  const value = useMemo(
    () => ({
      rooms: sortedRooms,
      isLoading,
      error,
      unreadTotal,
      pinned,
      muted,
      refresh,
      markSeen,
      togglePin,
      toggleMute,
    }),
    [sortedRooms, isLoading, error, unreadTotal, pinned, muted, refresh, markSeen, togglePin, toggleMute],
  );

  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}

export function useChats() {
  const value = useContext(ChatsContext);
  if (!value) throw new Error('useChats must be used inside ChatsProvider');
  return value;
}
