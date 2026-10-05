import { io } from 'socket.io-client';
import { getValidAccessToken } from './api';
import { getRefreshToken } from './session';

// Singleton socket instance. Call connectSocket() after login,
// disconnectSocket() on logout. getSocket() returns the current
// instance (or null if not connected).
//
// Server event list: backend/src/sockets/index.js

let socket = null;
let retryTimer = null;

/**
 * Create and connect the Socket.IO client. Idempotent — calling this
 * again after a previous connection will close the old one first.
 */
export function connectSocket() {
  clearTimeout(retryTimer);
  // Tear down any existing connection
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  socket = io(import.meta.env.VITE_SOCKET_URL, {
    // Re-read (and if needed refresh) the token on every connection attempt.
    auth: (callback) => {
      getValidAccessToken().then((token) => callback({ token })).catch(() => callback({ token: null }));
    },
    // socket.io-client reconnection defaults:
    //   reconnection: true, reconnectionAttempts: Infinity,
    //   reconnectionDelay: 1000, reconnectionDelayMax: 5000
    // These are fine for now — the heartbeat hook keeps presence
    // alive, and the server sweeps stale users every 30s.
  });

  // Log connection lifecycle for debugging (remove in production)
  socket.on('connect', () => {
    clearTimeout(retryTimer);
    console.log('[socket] connected', socket.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.error('[socket] connection error:', err.message);
    // Middleware rejection disables Socket.IO's automatic retries. Retry a
    // retained session after a temporary API outage; logout cancels this timer.
    if (getRefreshToken()) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => socket?.connect(), 5000);
    }
  });

  return socket;
}

/**
 * Gracefully disconnect and clean up.
 */
export function disconnectSocket() {
  clearTimeout(retryTimer);
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

/**
 * Get the current socket instance (may be null).
 */
export function getSocket() {
  return socket;
}
