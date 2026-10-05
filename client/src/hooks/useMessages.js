import { useCallback, useEffect, useState } from 'react';
import { listMessages } from '../services/messages.service';
import { useRealtime } from '../contexts/RealtimeContext';
function mergeMessages(current, rows) {
  const merged = new Map(current.map((message) => [message.id, message]));
  rows.forEach((message) => merged.set(message.id, message));
  return [...merged.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id.localeCompare(b.id));
}
export default function useMessages(roomId) {
  const { socket } = useRealtime(); const [messages, setMessages] = useState([]); const [isLoading, setIsLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => { let active = true; setIsLoading(true); setError(''); setMessages([]); listMessages(roomId).then(({ messages: rows }) => active && setMessages((current) => mergeMessages(current, rows))).catch((err) => active && setError(err.response?.data?.message || 'Could not load messages.')).finally(() => active && setIsLoading(false)); return () => { active = false; }; }, [roomId]);
  useEffect(() => {
    if (!socket) return;
    let active = true;
    const join = () => {
      socket.emit('join-room', { roomId });
      // Room subscriptions are lost on reconnect. Reload recent history to
      // recover messages sent while this browser was disconnected.
      listMessages(roomId).then(({ messages: rows }) => {
        if (!active) return;
        setError('');
        setMessages((current) => mergeMessages(current, rows));
      }).catch((err) => active && setError(err.response?.data?.message || 'Could not reload messages.'));
    };
    const receive = ({ message }) => {
      if (message.room_id === roomId) setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
    };
    socket.on('connect', join);
    socket.on('receive-message', receive);
    if (socket.connected) join();
    return () => {
      active = false;
      socket.off('connect', join);
      socket.off('receive-message', receive);
      if (socket.connected) socket.emit('leave-room', { roomId });
    };
  }, [roomId, socket]);
  const sendMessage = useCallback((content) => { if (!socket?.connected) throw new Error('Realtime connection is unavailable.'); socket.emit('send-message', { roomId, content }); }, [roomId, socket]);
  return { messages, isLoading, error, sendMessage };
}
