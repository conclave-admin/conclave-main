// Kept independent of React so visibility, sleep and reconnect behavior can be
// exercised with a deterministic clock and without a running browser.
export function startPresenceHeartbeat(socket, {
  roomId, nextRevision, document: doc = document, window: win = window,
  now = Date.now, setInterval: repeat = setInterval, clearInterval: stop = clearInterval,
}) {
  let timer;
  let previous = now();
  let suspended = false;
  const send = (background = false) => {
    if (!socket.connected) return;
    if (now() - previous >= 45000) win.dispatchEvent(new Event('conclave:presence-stale'));
    previous = now();
    const foreground = !background && !suspended && doc.visibilityState === 'visible' && doc.hasFocus();
    socket.emit('heartbeat', { foreground, roomId: foreground ? roomId : null, revision: nextRevision() }, (response) => {
      if (response?.ok === false || response?.data?.available === false) win.dispatchEvent(new Event('conclave:presence-stale'));
    });
  };
  const clear = () => { if (timer) stop(timer); timer = null; };
  const start = () => { suspended = false; clear(); send(); timer = repeat(send, 15000); };
  const focus = () => { suspended = false; send(); };
  const blur = () => send(true);
  const hide = () => { send(true); suspended = true; clear(); };
  const visibility = () => { if (doc.visibilityState === 'visible') start(); else send(true); };
  const resync = () => send();
  socket.on('connect', start);
  socket.on('disconnect', clear);
  socket.on('presence:resync', resync);
  doc.addEventListener('visibilitychange', visibility);
  win.addEventListener('focus', focus);
  win.addEventListener('blur', blur);
  win.addEventListener('pagehide', hide);
  win.addEventListener('pageshow', start);
  win.addEventListener('online', focus);
  if (socket.connected) start();
  return () => {
    clear();
    socket.off('connect', start); socket.off('disconnect', clear); socket.off('presence:resync', resync);
    doc.removeEventListener('visibilitychange', visibility);
    win.removeEventListener('focus', focus); win.removeEventListener('blur', blur);
    win.removeEventListener('pagehide', hide); win.removeEventListener('pageshow', start); win.removeEventListener('online', focus);
  };
}
