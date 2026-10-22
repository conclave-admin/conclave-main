import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { startPresenceHeartbeat } from '../lib/presenceHeartbeat';

export default function useHeartbeat(socket) {
  const { pathname } = useLocation();
  const revision = useRef(0);
  // Info pages remain subscribed but do not claim attention to the timeline.
  const roomId = /^\/chats\/([^/]+)\/?$/.exec(pathname)?.[1] || null;
  useEffect(() => {
    if (!socket) return undefined;
    return startPresenceHeartbeat(socket, { roomId, nextRevision: () => ++revision.current });
  }, [socket, roomId]);
}
