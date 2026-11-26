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
import { useNavigate } from "react-router-dom";
import {
  listRooms,
  resolveChatPreview,
  markRoomSeen,
  updateRoomPreferences,
} from "@/services/rooms.service";
import { useRealtime } from "./RealtimeContext";
import { usePresence } from "./PresenceContext";
import { useAuth } from "./AuthContext";
import { useToast } from "./ToastContext";
import { readChatList, saveChatList, saveRoomMetadata } from "../lib/fileCache";
import { getPreferences } from "@/services/users.service";
import { api } from "../lib/api";
import { getActiveRoomId } from "../lib/activeRoom";
import { playNotificationSound } from "../lib/notificationSound";
import { shouldAlert } from "../lib/inAppAlert";

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
  const navigate = useNavigate();
  const { toast, dismiss } = useToast();
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
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const alertedNotificationIds = useRef(new Map());
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  // Mirrors the server's allowsInterruption rules (notificationPolicy.service)
  // closely enough for an in-app alert, which is lower stakes than push: a
  // stale read here means a toast is shown or skipped a few seconds later
  // than a fresh preference change, never that private content leaks.
  const alertPolicy = useRef({
    activityLevel: "all",
    muted: {},
    dndUntil: null,
    inAppAlerts: true,
  });
  useEffect(() => {
    revokedRooms.current.clear();
  }, [userId]);

  useEffect(() => {
    if (!userId) return undefined;
    let active = true;
    const refreshPolicy = () => {
      getPreferences()
        .then((preferences) => {
          if (!active) return;
          alertPolicy.current = {
            ...alertPolicy.current,
            activityLevel: preferences?.activity_level ?? "all",
            muted: preferences?.muted ?? {},
            inAppAlerts: preferences?.in_app_alerts_enabled !== false,
            quietHours: preferences?.quiet_hours ?? [],
            quietHoursTimezone: preferences?.quiet_hours_timezone ?? "UTC",
          };
        })
        .catch(() => {});
      api
        .get("/experience/personal-settings")
        .then(({ data }) => {
          if (!active) return;
          alertPolicy.current = {
            ...alertPolicy.current,
            dndUntil: data?.data?.dnd_until ?? null,
          };
        })
        .catch(() => {});
    };
    refreshPolicy();
    window.addEventListener("conclave:preferences-changed", refreshPolicy);
    return () => {
      active = false;
      window.removeEventListener("conclave:preferences-changed", refreshPolicy);
    };
  }, [userId]);

  /**
   * An in-app toast + short sound for an incoming notification.
   *
   * Driven by the `notification` socket event rather than `chat:updated`,
   * because that event is the only one that knows *what kind* of thing
   * happened. `chat:updated` fires for every message and says nothing about
   * mentions, so it cannot honour `activity_level: "mentions"` — it would have
   * to either stay silent for mentions too, or alert for every message anyway.
   *
   * The server already skips this event for a recipient whose live device is
   * viewing that room, so the usual "you are watching it arrive" case never
   * reaches here. `getActiveRoomId` is the same-tab backstop for the gap
   * between a stale presence lease and reality.
   *
   * Suppressed by the same signals that suppress push: a muted or archived
   * room, `activity_level` none/mentions, the per-type override, an active
   * do-not-disturb window, and the in-app-alerts switch. This never overrides
   * those settings.
   */
  const notifyFromNotification = useCallback(
    (notification) => {
      if (
        !shouldAlert({
          notification,
          visibilityState: document.visibilityState,
          activeRoomId: getActiveRoomId(),
          policy: alertPolicy.current,
          mutedRooms: mutedRef.current,
          archivedRooms: archivedRef.current,
        })
      )
        return;

      const notificationId = notification.id;
      if (notificationId) {
        const now = Date.now();
        const seen = alertedNotificationIds.current;
        for (const [id, timestamp] of seen) {
          if (now - timestamp > 5 * 60 * 1000) seen.delete(id);
        }
        if (seen.has(notificationId)) return;
        seen.set(notificationId, now);
        while (seen.size > 300) seen.delete(seen.keys().next().value);
      }

      const context = notification.context || {};
      const roomId = context.room_id;
      const actor = context.actor_name || "Someone";
      const room = context.room_name;
      const title = room || actor;
      const description = context.message_preview
        ? room
          ? `${actor}: ${context.message_preview}`
          : context.message_preview
        : notification.type === "file_uploaded"
          ? `${actor} shared a file`
          : notification.type === "mention"
            ? `${actor} mentioned you`
            : `${actor} sent a message`;

      const id = toast({
        title,
        description,
        onClick: () => {
          dismiss(id);
          navigate(`/chats/${roomId}`);
        },
      });
      playNotificationSound();
    },
    [toast, dismiss, navigate],
  );

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
        const loaded = await listRooms({
          onPreview: (roomId, message) => {
            if (
              currentUser.current !== userId ||
              version !== refreshGeneration.current
            )
              return;
            setRooms((old) =>
              old.map((room) =>
                room.id === roomId &&
                (!message ||
                  conversationMessageVisible(message, userId, roomId)) &&
                (!room.last_message || room.last_message.id === message?.id)
                  ? {
                      ...room,
                      last_message: message,
                      has_message: Boolean(message),
                    }
                  : room,
              ),
            );
          },
        });
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
      // Deliberately no alert here: `chat:updated` cannot say what kind of
      // event this was, and the `notification` handler below is the one that
      // can. Alerting from both would double-toast every new message.
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
    // The notification event is emitted per recipient to `user:<id>`, already
    // filtered for blocks/visibility and skipped for anyone viewing the room
    // on a live device — which makes it the right source for an interruption.
    const onNotification = ({ notification } = {}) => {
      if (currentUser.current !== userId) return;
      notifyFromNotification(notification);
    };
    socket.on("notification", onNotification);
    return () => {
      socket.off("connect", refresh);
      socket.off("room:members", onMembers);
      socket.off("chat:updated", onChatUpdated);
      socket.off("notification", onNotification);
    };
  }, [socket, userId, refresh, notifyFromNotification]);

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
