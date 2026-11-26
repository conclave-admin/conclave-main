// Which conversation the current tab has open right now, so a background
// alert (in-app toast + sound) is not shown for a message in the very
// conversation already on screen. This is separate from the server-side
// "viewing" presence lease (phase 2): that one drives read receipts and
// typing across reconnects, this one is a same-tab synchronous read with no
// network round trip, so the chat list's `chat:updated` handler can check it
// the instant a message arrives.
let current = null;

export function setActiveRoomId(roomId) {
  current = roomId || null;
}

export function getActiveRoomId() {
  return current;
}
