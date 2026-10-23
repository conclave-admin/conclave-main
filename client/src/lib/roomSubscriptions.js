// Chat history and room details can observe the same room. Only the last
// observer leaves, so navigating between them cannot drop the subscription.
const subscriptions = new WeakMap();

export function subscribeToRoom(socket, roomId) {
  let rooms = subscriptions.get(socket);
  if (!rooms) {
    rooms = new Map();
    subscriptions.set(socket, rooms);
  }
  let entry = rooms.get(roomId);
  if (!entry) {
    const join = () => socket.emit("join-room", { roomId });
    entry = { count: 0, join };
    rooms.set(roomId, entry);
    socket.on("connect", join);
    if (socket.connected) join();
  }
  entry.count++;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--entry.count > 0) return;
    // React tears down the old route before mounting its replacement in the
    // same turn. Let the info page retain the subscription during that handoff.
    queueMicrotask(() => {
      if (entry.count !== 0) return;
      socket.off("connect", entry.join);
      rooms.delete(roomId);
      if (socket.connected) socket.emit("leave-room", { roomId });
    });
  };
}
