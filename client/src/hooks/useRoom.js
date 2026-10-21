import { useCallback, useEffect, useRef, useState } from 'react';
import { getRoom } from '../services/rooms.service';
import { useAuth } from '../contexts/AuthContext';
import { readRoomMetadata, saveRoomMetadata } from '../lib/fileCache';

/** Last-known room details let cached history and unsent media open offline. */
export default function useRoom(roomId) {
  const { user } = useAuth();
  const userId = user?.id;
  const [room, setRoom] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const scope = `${userId}:${roomId}`;
  const current = useRef({ scope, active: true });
  current.current.scope = scope;
  useEffect(() => {
    current.current.active = true;
    return () => { current.current.active = false; };
  }, []);

  const reload = useCallback(async () => {
    if (navigator.onLine === false) return readRoomMetadata(userId, roomId);
    try {
      const value = await getRoom(roomId);
      if (!current.current.active || current.current.scope !== scope) return null;
      setRoom(value);
      setError('');
      await saveRoomMetadata(userId, roomId, value);
      return value;
    } catch (err) {
      if (!current.current.active || current.current.scope !== scope) return null;
      if ([403, 404].includes(err.response?.status)) {
        setRoom(null);
        await saveRoomMetadata(userId, roomId, null);
      }
      setError(err.response?.data?.message || 'Could not refresh this conversation.');
      return null;
    }
  }, [roomId, userId, scope]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setRoom(null);
    setError('');
    const load = async () => {
      const cached = await readRoomMetadata(userId, roomId);
      if (!active) return;
      if (cached) { setRoom(cached); setIsLoading(false); }
      if (navigator.onLine === false) {
        if (!cached) setError('This conversation has not been saved on this device yet.');
        setIsLoading(false);
        return;
      }
      try {
        const value = await getRoom(roomId);
        if (!active) return;
        setRoom(value);
        setIsLoading(false);
        await saveRoomMetadata(userId, roomId, value);
      } catch (err) {
        if (!active) return;
        if ([403, 404].includes(err.response?.status)) {
          setRoom(null);
          await saveRoomMetadata(userId, roomId, null);
        }
        setError(err.response?.data?.message || 'Could not refresh this conversation.');
      } finally {
        if (active) setIsLoading(false);
      }
    };
    load();
    window.addEventListener('online', reload);
    return () => { active = false; window.removeEventListener('online', reload); };
  }, [roomId, userId, reload]);

  return { room, isLoading, error, reload };
}
