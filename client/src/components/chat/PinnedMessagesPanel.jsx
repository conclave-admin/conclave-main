import { useCallback, useEffect, useRef, useState } from 'react';
import Avatar from '@/components/ui/Avatar';
import PopoverMenu from '@/components/ui/PopoverMenu';
import IconChevron from '@/assets/icons/chevron-down.svg?react';
import IconClose from '@/assets/icons/close.svg?react';
import IconMore from '@/assets/icons/more.svg?react';
import IconPin from '@/assets/icons/pin.svg?react';
import { useToast } from '@/contexts/ToastContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { formatClockTime, messageSummary } from '@/lib/messageMeta';
import { listPinnedMessages, unpinMessage } from '@/services/messages.service';

/**
 * Messages pinned to this room, in a panel under the header.
 *
 * Built to WhatsApp's shape rather than the decision strip's: decisions are
 * short, standalone objects with titles, so they sit in a horizontal row of
 * chips. Messages are conversation — long, wrapped, and read in a scroll — so
 * they get a full-width band that opens into a list with one line per message
 * per screen. Reusing the chip strip here would have meant either truncating a
 * message to a dozen characters or letting the row scroll horizontally through
 * text that is meant to be read left to right.
 *
 * Collapsed, the band shows the most recent pin: a pinned message is a
 * reference that has to be recoverable in one glance, not a list to browse, so
 * the summary is what is permanently visible and the full list is one tap away.
 *
 * Only room pins. A personal bookmark is nobody else's business, so the panel
 * deliberately ignores the `user` scope that GET /messages/room/:id/pinned
 * also leaves out.
 *
 * Driven by the `pins` object the server attaches to every message and by the
 * `message:pinned` / `message:unpinned` events, which carry a full message
 * rather than a delta — so an unpin is a replace, not a filter.
 */
export default function PinnedMessagesPanel({ roomId, isAdmin = false, viewerId, onJumpToMessage }) {
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState(null);
  const triggerRef = useRef(null);
  const { toast } = useToast();
  const { socket } = useRealtime();

  const merge = useCallback((incoming) => {
    setMessages((prev) => {
      const index = prev.findIndex((item) => item.id === incoming.id);
      const next = [...prev];
      if (index === -1) next.push(incoming);
      else next[index] = incoming;
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setIsOpen(false);
    listPinnedMessages(roomId)
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch(() => {
        // A room you are not in answers 403 here. Showing nothing is the right
        // answer to "you cannot see these", not an error the reader can act on.
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  useEffect(() => {
    if (!socket) return undefined;

    const onPinned = (payload) => {
      if (payload?.message?.room_id === roomId) merge(payload.message);
    };
    const onUnpinned = (payload) => {
      if (payload?.message?.room_id !== roomId) return;
      const { message } = payload;
      // The server sends the message as it now is. If it still holds a pin the
      // unpin was somebody else's personal bookmark, so it stays on the panel.
      if (message.pins?.room) merge(message);
      else setMessages((prev) => prev.filter((item) => item.id !== message.id));
    };

    socket.on('message:pinned', onPinned);
    socket.on('message:unpinned', onUnpinned);
    return () => {
      socket.off('message:pinned', onPinned);
      socket.off('message:unpinned', onUnpinned);
    };
  }, [socket, roomId, merge]);

  // Three exclusions, all applied here rather than at each call site:
  //   deleted_at  a tombstone cannot be read, so it is not a reference to anything
  //   pins.room   the unpin handler merges the message as it now is — with no
  //               room pin — so the list has to drop it, or the row below reads
  //               pins.room.display_name off a null
  const pinned = messages.filter(
    (message) => !message.is_deleted && !message.deleted_at && message.pins?.room,
  );

  if (isLoading || pinned.length === 0) return null;

  const latest = pinned[pinned.length - 1];
  const canUnpin = (message) =>
    message.pins?.room && (message.pins.room.user_id === viewerId || isAdmin);

  const runUnpin = async (message) => {
    try {
      const updated = await unpinMessage(message.id, 'room');
      // A pin that was already gone answers with a sentinel carrying no pins
      // rather than a 404, so a retried unpin does not look like a failure —
      // and that sentinel is not a message, so the row is dropped instead of
      // being replaced by one that would render empty.
      if (updated?.pins) merge(updated);
      else setMessages((prev) => prev.filter((item) => item.id !== message.id));
    } catch (err) {
      toast({
        title: 'Unpin failed',
        description: err.response?.data?.message || 'Could not unpin this message.',
        tone: 'error',
      });
    }
  };

  return (
    <div className="shrink-0 border-b border-line bg-surface">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-controls="pinned-messages-list"
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30 md:px-7"
      >
        <IconPin className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />

        {/* min-w-0 on the text column is what makes the truncation work: a flex
            child will not shrink below its content width without it, so the
            chevron was being pushed off the panel by a long message. */}
        <span className="min-w-0 flex-1">
          <span className="block text-metadata text-muted">
            {pinned.length === 1 ? 'Pinned message' : `Pinned messages · ${pinned.length}`}
          </span>
          <span className="block truncate text-body text-ink">
            <span className="text-muted">{latest.sender_name}: </span>
            {messageSummary(latest)}
          </span>
        </span>

        <IconChevron
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <ul id="pinned-messages-list" className="max-h-72 overflow-y-auto border-t border-line">
          {pinned.map((message) => (
            <li
              key={message.id}
              className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 md:px-7"
            >
              <Avatar name={message.sender_name} src={message.sender_avatar} size="md" />

              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span className="truncate text-body text-ink">{message.sender_name}</span>
                  <span className="shrink-0 text-metadata text-muted">
                    {formatClockTime(message.created_at)}
                  </span>
                </p>
                {message.content ? (
                  // Three lines is the ceiling: a pinned message is a reference,
                  // and anything longer belongs in the timeline. Deliberately
                  // not line-clamp, which the Tailwind build here has no plugin
                  // for — max-h with overflow-hidden is the same result in core.
                  <button type="button" onClick={() => { setIsOpen(false); onJumpToMessage?.(message); }} className="mt-1 max-h-[4.5rem] overflow-hidden whitespace-pre-wrap break-words text-left text-body text-muted hover:text-brand">
                    {message.content}
                  </button>
                ) : (
                  <button type="button" onClick={() => { setIsOpen(false); onJumpToMessage?.(message); }} className="mt-1 text-body text-muted">{messageSummary(message)}</button>
                )}
                <p className="mt-1 text-metadata text-muted">
                  Pinned by {message.pins.room.display_name}
                </p>
              </div>

              {canUnpin(message) && (
                <>
                  <button
                    ref={triggerRef}
                    type="button"
                    onClick={() => setMenuFor((open) => (open === message.id ? null : message.id))}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === message.id}
                    aria-label="Pin actions"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                  >
                    <IconMore className="h-4 w-4" aria-hidden="true" />
                  </button>

                  <PopoverMenu
                    open={menuFor === message.id}
                    onClose={() => setMenuFor(null)}
                    triggerRef={triggerRef}
                    align="end"
                    label="Pin actions"
                    className="w-56"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        runUnpin(message);
                        setMenuFor(null);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas"
                    >
                      <IconClose className="h-4 w-4 text-muted" aria-hidden="true" />
                      Unpin for everyone
                    </button>
                    <p className="border-t border-line px-2.5 pb-1 pt-2 text-metadata text-muted">
                      Only the pinner or a room admin can unpin this
                    </p>
                  </PopoverMenu>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
