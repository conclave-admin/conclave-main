import { conversationMessageVisible } from "../lib/clearedConversations";
import { useSyncReconciler } from "./SyncContext";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  listRooms,
  resolveChatPreview,
  markRoomSeen,
  updateRoomPreferences,
} from "@/services/rooms.service";
import { useRealtime } from "./RealtimeContext";
import { usePresence } from "./PresenceContext";
import { useAuth } from "./AuthContext";
import { readChatList, saveChatList, saveRoomMetadata } from "../lib/fileCache";

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
  const [error, setError] = useState("");
  const [pinned, setPinned] = useState([]);
  const [muted, setMuted] = useState([]);
  const [archived, setArchived] = useState([]);
  const { typingByRoom, recordingByRoom } = usePresence();
  const revokedRooms = useRef(new Set());
  const membershipEpoch = useRef(0);
  const refreshGeneration = useRef(0);
  const currentUser = useRef(userId);
  currentUser.current = userId;
  useEffect(() => {
    revokedRooms.current.clear();
  }, [userId]);

  const refresh = useCallback(
    async (options = {}) => {
      const epoch = membershipEpoch.current;
      const version = ++refreshGeneration.current;
      setIsLoading(true);
      setError("");
      const apply = (rows) => {
        if (
          currentUser.current !== userId ||
          version !== refreshGeneration.current ||
          (options?.isCurrent && !options.isCurrent())
        ) {
          if (options?.strict) throw new Error("Chat refresh superseded");
          return;
        }
        const loaded = rows
          .filter((room) => !revokedRooms.current.has(room.id))
          .map((room) =>
            room.last_message &&
            !conversationMessageVisible(room.last_message, userId, room.id)
              ? { ...room, last_message: null, has_message: false }
              : room,
          );
        setRooms(loaded);
        setPinned(
          loaded.filter((room) => room.is_pinned).map((room) => room.id),
        );
        setMuted(loaded.filter((room) => room.is_muted).map((room) => room.id));
        setArchived(
          loaded.filter((room) => room.is_archived).map((room) => room.id),
        );
      };
      const cached = await readChatList(userId);
      if (cached.length && !options?.strict) {
        apply(cached);
        setIsLoading(false);
      }
      if (navigator.onLine === false) {
        if (!cached.length)
          setError("No conversations have been saved on this device yet.");
        setIsLoading(false);
        return;
      }
      try {
        const loaded = await listRooms();
        if (
          currentUser.current === userId &&
          membershipEpoch.current === epoch
        ) {
          for (const room of loaded) revokedRooms.current.delete(room.id);
        }
        apply(loaded);
      } catch (err) {
        setError(err.response?.data?.message || "Could not load chats.");
        if (options?.strict) throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [userId],
  );

  useSyncReconciler(
    async (batch) => {
      if (
        batch.reset ||
        batch.changes.some((c) =>
          [
            "message",
            "room",
            "membership",
            "profile",
            "preferences",
            "block",
          ].includes(c.kind),
        )
      )
        await refresh({ strict: true, isCurrent: batch.isCurrent });
    },
    [userId],
  );

  useEffect(() => {
    refresh();
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [refresh]);

  useEffect(() => {
    if (!isLoading) saveChatList(userId, rooms);
  }, [userId, rooms, isLoading]);

  // Phase 1 emits this after every message create, edit and delete, to each
  // member's personal channel. The client was not listening to it at all until
  // now, which meant the sidebar only changed on a full reload.
  useEffect(() => {
    if (!socket) return undefined;

    const onChatUpdated = async ({
      roomId,
      lastMessage,
      unreadCount,
      roomSequence,
    }) => {
      try {
        lastMessage = await resolveChatPreview(roomId, lastMessage);
      } catch {
        return;
      }
      if (currentUser.current !== userId) return;
      // Delayed pre-clear events must not restore text from hidden history.
      if (
        lastMessage &&
        !conversationMessageVisible(lastMessage, userId, roomId)
      )
        return;
      setRooms((current) =>
        current.map((room) =>
          room.id === roomId &&
          !(
            roomSequence != null &&
            room.last_message?.room_sequence != null &&
            BigInt(roomSequence) < BigInt(room.last_message.room_sequence)
          )
            ? {
                ...room,
                last_message: lastMessage,
                unread_count: unreadCount,
                has_message: Boolean(lastMessage),
              }
            : room,
        ),
      );
    };

    const onMembers = ({ roomId, userId: targetId, action }) => {
      membershipEpoch.current++;
      if (targetId === userId && ["removed", "left"].includes(action)) {
        revokedRooms.current.add(roomId);
        setRooms((rows) => rows.filter((room) => room.id !== roomId));
        for (const setter of [setPinned, setMuted, setArchived])
          setter((ids) => ids.filter((id) => id !== roomId));
        saveRoomMetadata(userId, roomId, null);
      } else if (targetId === userId && action === "joined") {
        revokedRooms.current.delete(roomId);
        refresh();
      }
    };
    socket.on("connect", refresh);
    socket.on("room:members", onMembers);
    socket.on("chat:updated", onChatUpdated);
    return () => {
      socket.off("connect", refresh);
      socket.off("room:members", onMembers);
      socket.off("chat:updated", onChatUpdated);
    };
  }, [socket, userId, refresh]);

  useEffect(() => {
    const cleared = (event) => {
      if (event.detail?.userId !== userId) return;
      setRooms((rows) =>
        rows.map((room) =>
          room.id === event.detail.roomId &&
          room.last_message &&
          !conversationMessageVisible(room.last_message, userId, room.id)
            ? {
                ...room,
                last_message: null,
                has_message: false,
                ...(event.detail.scope === "account"
                  ? { unread_count: 0 }
                  : {}),
              }
            : room,
        ),
      );
    };
    window.addEventListener("conclave:conversation-cleared", cleared);
    return () =>
      window.removeEventListener("conclave:conversation-cleared", cleared);
  }, [userId]);

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
        current.map((room) =>
          room.id === roomId ? { ...room, unread_count: 0 } : room,
        ),
      );
      try {
        await markRoomSeen(roomId);
      } catch {
        refresh();
      }
    },
    [refresh],
  );

  const togglePreference = useCallback(
    async (roomId, key, setter, current) => {
      const value = !current.includes(roomId);
      setter((rows) =>
        value ? [...rows, roomId] : rows.filter((id) => id !== roomId),
      );
      try {
        await updateRoomPreferences(roomId, { [key]: value });
        setRooms((rows) =>
          rows.map((room) =>
            room.id === roomId ? { ...room, [`is_${key}`]: value } : room,
          ),
        );
      } catch {
        refresh();
      }
    },
    [refresh],
  );

  const togglePin = useCallback(
    (roomId) => togglePreference(roomId, "pinned", setPinned, pinned),
    [togglePreference, pinned],
  );

  const toggleMute = useCallback(
    (roomId) => togglePreference(roomId, "muted", setMuted, muted),
    [togglePreference, muted],
  );
  const toggleArchive = useCallback(
    (roomId) => togglePreference(roomId, "archived", setArchived, archived),
    [togglePreference, archived],
  );

  const sortedRooms = useMemo(() => {
    const recency = (room) => room.last_message?.created_at || "";
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
    if (typeof navigator === "undefined") return;
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
      recordingByRoom,
      refresh,
      markSeen,
      togglePin,
      toggleMute,
      toggleArchive,
    }),
    [
      sortedRooms,
      rooms,
      archived,
      typingByRoom,
      recordingByRoom,
      isLoading,
      error,
      unreadTotal,
      pinned,
      muted,
      refresh,
      markSeen,
      togglePin,
      toggleMute,
      toggleArchive,
    ],
  );

  return (
    <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>
  );
}

export function useChats() {
  const value = useContext(ChatsContext);
  if (!value) throw new Error("useChats must be used inside ChatsProvider");
  return value;
}
