import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRealtime } from "./RealtimeContext";
import { useAuth } from "./AuthContext";
import { useSyncReconciler } from "./SyncContext";
import { listNotifications, markSeen } from "../services/notifications.service";
const NotificationsContext = createContext(null);
export function NotificationsProvider({ children }) {
  const { socket, isConnected } = useRealtime();
  const { user } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const loaded = useRef(0);
  loaded.current = notifications.length;
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      let page = await listNotifications();
      const rows = [...page.notifications];
      const count = page.unreadCount;
      while (page.nextCursor && rows.length < loaded.current) {
        page = await listNotifications({ before: page.nextCursor });
        rows.push(...page.notifications);
      }
      if (generation.current !== version)
        throw new Error("Notification refresh superseded");
      setNotifications([...new Map(rows.map((row) => [row.id, row])).values()]);
      setUnreadCount(count);
      setNextCursor(page.nextCursor);
      setError("");
    } catch (err) {
      if (generation.current === version)
        setError(
          err.response?.data?.message || "Could not refresh notifications.",
        );
      throw err;
    } finally {
      if (generation.current === version) setIsLoading(false);
    }
  }, [user?.id]);
  useEffect(() => {
    setNotifications([]);
    setUnreadCount(0);
    setIsLoading(true);
    refresh().catch(() => {});
    return () => {
      generation.current++;
    };
  }, [refresh]);
  useSyncReconciler(
    async (batch) => {
      if (
        batch.reset ||
        batch.changes.some((c) =>
          ["notification", "membership", "block"].includes(c.kind),
        )
      )
        await refresh();
    },
    [user?.id],
  );
  useEffect(() => {
    if (!socket) return undefined;
    let timer;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => refresh().catch(() => {}), 100);
    };
    // IDs and counts are server-owned. Duplicate/replayed events request an
    // authoritative snapshot instead of applying unreliable arithmetic deltas.
    const events = [
      "notification",
      "notification:seen",
      "connect",
      "privacy:changed",
    ];
    events.forEach((name) => socket.on(name, schedule));
    return () => {
      clearTimeout(timer);
      events.forEach((name) => socket.off(name, schedule));
    };
  }, [socket, refresh]);
  const mark = useCallback(
    async (values) => {
      setNotifications((rows) =>
        rows.map((row) =>
          values.all || row.id === values.notificationId
            ? { ...row, seen: true }
            : row,
        ),
      );
      try {
        await markSeen(values);
      } catch (err) {
        if (err.response?.status !== 404)
          setError("Could not mark this notification read.");
      }
      await refresh().catch(() => {});
    },
    [refresh],
  );
  const markOne = useCallback(
    (notificationId) => mark({ notificationId }),
    [mark],
  );
  const markAll = useCallback(() => mark({ all: true }), [mark]);
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const version = generation.current;
    try {
      const page = await listNotifications({ before: nextCursor });
      if (version !== generation.current) return;
      setNotifications((rows) => [
        ...new Map(
          [...rows, ...page.notifications].map((row) => [row.id, row]),
        ).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch {
      setError("Could not load more notifications.");
    }
  }, [nextCursor]);
  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      nextCursor,
      isLoading,
      error,
      isConnected,
      markOne,
      markAll,
      loadMore,
    }),
    [
      notifications,
      unreadCount,
      nextCursor,
      isLoading,
      error,
      isConnected,
      markOne,
      markAll,
      loadMore,
    ],
  );
  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}
export function useNotifications() {
  const value = useContext(NotificationsContext);
  if (!value)
    throw new Error(
      "useNotifications must be used inside NotificationsProvider",
    );
  return value;
}
