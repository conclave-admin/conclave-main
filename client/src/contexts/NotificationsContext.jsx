import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRealtime } from './RealtimeContext';
import { listNotifications, markSeen } from '../services/notifications.service';

const NotificationsContext = createContext(null);

/**
 * The caller's notifications, and the single number the bell badge shows.
 *
 * Sits here rather than in the page because two surfaces need the same count
 * and fetching it twice would mean two requests that can disagree for a
 * moment — the badge and the page would briefly show different numbers, which
 * reads as a bug even when both are correct.
 *
 * Realtime comes from `notification` and `notification:seen`, both emitted to
 * the personal room `user:<id>`, which `sockets/index.js` joins on connect.
 * There is no join for the client to make; listening is the whole of it.
 *
 * The `notification:seen` handling is the subtle part. That event carries a
 * DELTA — how many rows a mark-seen call changed — and the server emits it to
 * every socket the user has open, including the tab that made the call. So a tab
 * that subtracts from its own request and then again from the echo would drive
 * the badge below what is actually unread.
 *
 * Suppression is a COUNT of in-flight optimistic marks, not a list of the
 * values we expect back. The two are not equivalent: `markSeen` is concurrent
 * with its own echo, so the echo can arrive before the response that tells this
 * tab what the value was — and matching on a value we do not have yet cannot
 * work. A counter does not need the value. Each optimistic mark produces
 * exactly one echo to this tab, so decrementing the counter and dropping that
 * echo is correct regardless of arrival order, and an echo from another tab is
 * applied normally because the counter has already been spent.
 *
 * This also survives the server answering `updated: 0` — a row that was already
 * seen — because a zero delta changes nothing either way.
 */
export function NotificationsProvider({ children }) {
  const { socket, isConnected } = useRealtime();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // How many mark-seen calls this tab has made whose echo it has not yet seen.
  const pendingOwnMarks = useRef(0);

  const applyDelta = useCallback((updated) => {
    if (!updated) return;
    setUnreadCount((count) => Math.max(0, count - updated));
  }, []);

  // --- initial page ----------------------------------------------------------
  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError('');

    listNotifications()
      .then(({ notifications: rows, unreadCount: count, nextCursor: cursor }) => {
        if (!active) return;
        setNotifications(rows);
        setUnreadCount(count);
        setNextCursor(cursor);
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || 'Could not load notifications.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  // --- live ------------------------------------------------------------------
  useEffect(() => {
    if (!socket) return undefined;

    // The list payload and this event's payload are byte-identical — the
    // server presents both through the same function — so an incoming row is
    // inserted as-is with no translation and no refetch.
    const onNotification = ({ notification }) => {
      if (!notification) return;
      setNotifications((prev) =>
        prev.some((item) => item.id === notification.id) ? prev : [notification, ...prev],
      );
      if (!notification.seen) setUnreadCount((count) => count + 1);
    };

    const onSeen = ({ updated }) => {
      if (pendingOwnMarks.current > 0) {
        pendingOwnMarks.current -= 1;
        return;
      }
      applyDelta(updated);
    };

    socket.on('notification', onNotification);
    socket.on('notification:seen', onSeen);
    return () => {
      socket.off('notification', onNotification);
      socket.off('notification:seen', onSeen);
    };
  }, [socket, applyDelta]);

  // --- actions ---------------------------------------------------------------

  /** Mark one notification seen, and clear it from the list's unread state. */
  const markOne = useCallback(
    async (notificationId) => {
      // The list flips immediately; the count does not. Waiting for the round
      // trip to clear one row of a list the reader is already looking at makes
      // the row feel sticky, and the badge is corrected by either the echo or
      // the response — whichever lands first, exactly once.
      setNotifications((prev) =>
        prev.map((item) => (item.id === notificationId ? { ...item, seen: true } : item)),
      );
      pendingOwnMarks.current += 1;
      try {
        const { updated } = await markSeen({ notificationId });
        applyDelta(updated);
      } catch {
        pendingOwnMarks.current = Math.max(0, pendingOwnMarks.current - 1);
      }
    },
    [applyDelta],
  );

  /** Mark everything seen. Used by the page's "Mark all as read". */
  const markAll = useCallback(async () => {
    setNotifications((prev) => prev.map((item) => ({ ...item, seen: true })));
    pendingOwnMarks.current += 1;
    try {
      const { updated } = await markSeen({ all: true });
      applyDelta(updated);
    } catch {
      pendingOwnMarks.current = Math.max(0, pendingOwnMarks.current - 1);
    }
  }, [applyDelta]);

  /** Fetch the next page and append it. */
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    try {
      const { notifications: rows, nextCursor: cursor } = await listNotifications({
        before: nextCursor,
      });
      setNotifications((prev) => {
        const known = new Set(prev.map((item) => item.id));
        return [...prev, ...rows.filter((item) => !known.has(item.id))];
      });
      setNextCursor(cursor);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load more notifications.');
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
    [notifications, unreadCount, nextCursor, isLoading, error, isConnected, markOne, markAll, loadMore],
  );

  return (
    <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const value = useContext(NotificationsContext);
  if (!value) {
    throw new Error('useNotifications must be used inside NotificationsProvider');
  }
  return value;
}
