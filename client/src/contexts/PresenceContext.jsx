import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRealtime } from './RealtimeContext';

const PresenceContext = createContext(null);

/**
 * Who is online, and where that number can be trusted.
 *
 * `room-presence` is sent on join-room and is a COMPLETE roster for that room:
 * `{ roomId, onlineUserIds }`. Anything drawn from it is correct.
 *
 * Presence is room scoped. The server sends a complete `room-presence` roster
 * on join and room scoped updates as members connect or disconnect. This keeps
 * a private room's activity from leaking to users who are not members.
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

    socket.on('room-presence', onRoomPresence);

    return () => {
      socket.off('room-presence', onRoomPresence);
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
