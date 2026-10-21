import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { useRealtime } from './RealtimeContext';
import { useToast } from './ToastContext';
import { cancelOutbox, deleteOutbox, listOutbox, putOutboxBatch, updateOutbox,
  readRoomMessages, saveRoomMessages } from '../lib/fileCache';
import { createClientId, createOutbox } from '../lib/outbox';
import { generateMediaMetadata } from '../lib/mediaMetadata';
import { compressImage } from '../lib/media';
import { uploadMedia, cancelMediaSession } from '../services/mediaUploads.service';
import { rememberUploadedFile } from '../services/attachments.service';
import { getSessionUserId } from '../lib/session';
import { isDevAuthBypass } from '../config/devPreview';

const OutboxContext = createContext(null);
const store = { list: listOutbox, add: putOutboxBatch, update: updateOutbox,
  remove: deleteOutbox, cancel: cancelOutbox };

function sessionMatches(userId) {
  return isDevAuthBypass || getSessionUserId() === userId;
}

function socketSend(socket, payload, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (error, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(message);
    };
    const abort = () => finish(new DOMException('Connection interrupted', 'AbortError'));
    if (signal.aborted || !socket?.connected) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('No send confirmation yet. Retrying safely…')), 15000);
    const acknowledge = (ack) => {
      if (signal.aborted) return;
      if (!ack?.ok) {
        const error = new Error(ack?.error || 'The server could not send this message.');
        error.status = ack?.status;
        error.definitive = ack?.status >= 400 && ack.status < 500;
        error.permanent = !ack?.status || (ack.status < 500 && ![408, 429].includes(ack.status));
        finish(error);
      } else if (ack.data?.client_id !== payload.clientId || ack.data?.room_id !== payload.roomId) {
        finish(new Error('The send confirmation did not match this message.'));
      } else finish(null, ack.data);
    };
    try { socket.emit('send-message', payload, acknowledge); }
    catch (error) { finish(error); }
  });
}

function AccountOutbox({ user, socket, children }) {
  const [entries, setEntries] = useState([]);
  const manager = useRef(null);
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    if (!user?.id) return undefined;
    let active = true;
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`conclave-outbox:${user.id}`) : null;
    const report = (error) => {
      if (active) toastRef.current({ title: 'Could not restore unsent messages', description: error.message, tone: 'error' });
    };
    const instance = createOutbox({
      userId: user.id, store, upload: uploadMedia, cancelUpload: cancelMediaSession, prepareMetadata: generateMediaMetadata,
      prepare: (blob, filename) => compressImage(new File([blob], filename, { type: blob.type })),
      remember: rememberUploadedFile,
      send: (payload, signal) => socketSend(socketRef.current, payload, signal),
      canSend: () => active && sessionMatches(user.id) && socketRef.current?.connected && navigator.onLine !== false,
      onChange: setEntries,
      onError: report,
      changed: () => channel?.postMessage('changed'),
      withLock: (work) => navigator.locks
        ? navigator.locks.request(`conclave-outbox:${user.id}`, { ifAvailable: true }, (lock) => lock ? work() : undefined)
        : work(),
      onSent: (message) => {
        if (!active) return;
        window.dispatchEvent(new CustomEvent('conclave:outbox-sent', { detail: { userId: user.id, message } }));
        // Keep completion available when the user has navigated away from the room.
        readRoomMessages(user.id, message.room_id).then((cached) => {
          if (active) return saveRoomMessages(user.id, message.room_id,
            [...cached.filter((row) => row.id !== message.id && row.client_id !== message.client_id), message]);
        }).catch(() => {});
      },
    });
    manager.current = instance;
    instance.start().catch(() => {});
    const stop = () => { active = false; instance.stop(); setEntries([]); };
    const sessionChanged = (event) => {
      if ((event.key === 'accessToken' || event.key === null) && !sessionMatches(user.id)) stop();
    };
    const wake = () => instance.wake();
    const pause = () => instance.pause();
    const refresh = () => { instance.refresh().catch(report); instance.wake(); };
    channel?.addEventListener('message', refresh);
    window.addEventListener('online', wake);
    window.addEventListener('offline', pause);
    window.addEventListener('conclave:outbox-stop', stop);
    window.addEventListener('conclave:session-ended', stop);
    window.addEventListener('storage', sessionChanged);
    return () => {
      stop();
      manager.current = null;
      channel?.close();
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', pause);
      window.removeEventListener('conclave:outbox-stop', stop);
      window.removeEventListener('conclave:session-ended', stop);
      window.removeEventListener('storage', sessionChanged);
    };
  }, [user?.id]);

  useEffect(() => {
    const wake = () => manager.current?.wake();
    const pause = () => manager.current?.pause();
    socket?.on('connect', wake);
    socket?.on('disconnect', pause);
    if (socket?.connected) wake();
    return () => { socket?.off('connect', wake); socket?.off('disconnect', pause); };
  }, [socket]);

  const enqueue = useCallback(async (roomId, messages) => {
    if (!user?.id || !manager.current) throw new Error('Please sign in before sending.');
    if (!sessionMatches(user.id)) throw new Error('Your account changed. Reload before sending.');
    const createdAt = Date.now();
    const items = messages.map((message, index) => {
      const clientId = createClientId();
      const { media, forwardPreview, ...body } = message;
      return { key: `${user.id}:${roomId}:${clientId}`, userId: user.id, roomId, clientId,
        tempId: `optimistic-${clientId}`, createdAt: createdAt + index,
        state: 'queued', attempts: 0, retryAt: 0, sendAttempted: false,
        payload: { ...body, roomId, clientId }, forwardPreview: forwardPreview || null, media: media || null };
    });
    try { await manager.current.enqueue(items); }
    catch (error) {
      throw new Error(`Could not save this message on your device. Keep the files here and free storage or allow site storage, then retry. ${error.message}`);
    }
  }, [user?.id]);

  const value = useMemo(() => ({ entries, enqueue,
    retry: (key) => manager.current?.retry(key),
    cancel: (key) => manager.current?.cancel(key),
  }), [entries, enqueue]);
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

export function OutboxProvider({ children }) {
  const { user } = useAuth();
  const { socket } = useRealtime();
  return <AccountOutbox key={user?.id || 'signed-out'} user={user} socket={socket}>{children}</AccountOutbox>;
}

export function useOutbox() {
  const value = useContext(OutboxContext);
  if (!value) throw new Error('useOutbox must be used inside OutboxProvider');
  return value;
}
