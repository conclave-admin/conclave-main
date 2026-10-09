import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRealtime } from './RealtimeContext';

const PresenceContext = createContext(null);

/**
 * Who is online, and where that number can be trusted.
 *
 * `room-presence` is sent on join-room and is a COMPLETE roster for that room:
 * `{ roomId, onlineUserIds }`. Anything drawn from it is correct.
 *
 * `user-online` / `user-offline` are global deltas, and they only ever cover
 * people who change state AFTER this socket connected — the server broadcasts
 * the first-socket join but never sends a starting roster. So a set built from
 * those two alone says everyone was offline until they happened to reconnect,
 * which is not a weaker version of the truth, it is a different and wrong one.
 *
 * That is why this context tracks room rosters as the source of truth and
 * treats the global deltas as supplementary. Presence dots are drawn in the
 * open conversation, where the data is complete, and deliberately NOT in the
 * chat list — a grey dot beside someone who has been online for an hour is
 * worse than no dot. Closing that needs the server to emit the current online
 * set to a socket on connect, which is a small change and is not made here.
 */
export function PresenceProvider({ children }) {
  const { socket } = useRealtime();
  // roomId -> Set<userId>
  const [roomPresence, setRoomPresence] = useState(() => new Map());

  useEffect(() => {
    if (!socket) return undefined;

    const onRoomPresence = ({ roomId, onlineUserIds }) => {
      setRoomPresence((prev) => {
        const next = new Map(prev);
        next.set(roomId, new Set(onlineUserIds || []));
        return next;
      });
    };

    // Deltas, applied to whichever rooms this client has a roster for. Safe
    // because a room with no roster is simply not touched — it never invents
    // an "offline" for someone whose state was never known.
    const onOnline = ({ userId }) => {
      setRoomPresence((prev) => {
        const next = new Map();
        for (const [roomId, ids] of prev) {
          if (ids.has(userId)) continue;
          const copy = new Set(ids);
          copy.add(userId);
          next.set(roomId, copy);
        }
        return next.size === prev.size ? prev : next;
      });
    };

    const onOffline = ({ userId }) => {
      setRoomPresence((prev) => {
        const next = new Map();
        let changed = false;
        for (const [roomId, ids] of prev) {
          if (!ids.has(userId)) {
            next.set(roomId, ids);
            continue;
          }
          const copy = new Set(ids);
          copy.delete(userId);
          next.set(roomId, copy);
          changed = true;
        }
        return changed ? next : prev;
      });
    };

    socket.on('room-presence', onRoomPresence);
    socket.on('user-online', onOnline);
    socket.on('user-offline', onOffline);

    return () => {
      socket.off('room-presence', onRoomPresence);
      socket.off('user-online', onOnline);
      socket.off('user-offline', onOffline);
    };
  }, [socket]);

  const isOnlineIn = useCallback(
    (roomId, userId) => Boolean(roomPresence.get(roomId)?.has(userId)),
    [roomPresence],
  );

  const value = useMemo(
    () => ({ roomPresence, isOnlineIn }),
    [roomPresence, isOnlineIn],
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function usePresence() {
  const value = useContext(PresenceContext);
  if (!value) throw new Error('usePresence must be used inside PresenceProvider');
  return value;
}
