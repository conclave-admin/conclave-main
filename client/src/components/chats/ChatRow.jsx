import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import Badge from '@/components/ui/Badge';
import IconMore from '@/assets/icons/more-vertical.svg?react';
import IconMute from '@/assets/icons/mute.svg?react';
import IconPin from '@/assets/icons/pin.svg?react';
import { useChats } from '@/contexts/ChatsContext';
import { formatRoomPreview, formatRoomTime } from '@/lib/roomMeta';

/**
 * One conversation in the chat list.
 *
 * The row is a link and the overflow button is a sibling, not a child: a
 * <button> inside an <a> is invalid HTML, and browsers resolve the nesting by
 * making the inner element win — so the menu would swallow the navigation
 * instead of sitting beside it.
 *
 * The overflow control is always visible rather than hover-revealed. Hover
 * does not exist on a touch device, and a control that only appears on a
 * pointer is a control that does not exist for half the audience — especially
 * since pin and mute are this phase's only local-only features and therefore
 * have nowhere else to live.
 *
 * @param {object} room - one enriched `GET /rooms` row
 */
export default function ChatRow({ room }) {
  const { pinned, muted, togglePin, toggleMute } = useChats();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef(null);

  const isPinned = pinned.includes(room.id);
  const isMuted = muted.includes(room.id);
  const unread = room.unread_count || 0;

  useEffect(() => {
    if (!menuOpen) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const onPointerDown = (event) => {
      if (!wrapperRef.current?.contains(event.target)) setMenuOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [menuOpen]);

  return (
    <li ref={wrapperRef} className="relative">
      {/* No markSeen here: Room does it on open, which covers the rail, a
          deep link and the back button too — not just this click. */}
      <NavLink
        to={`/chats/${room.id}`}
        className={({ isActive }) =>
          `flex items-start gap-3 rounded-lg px-3 py-2.5 pr-10 transition-colors ${
            isActive ? 'bg-brand-soft' : 'hover:bg-canvas'
          }`
        }
      >
        <Avatar name={room.display_name} src={room.display_avatar} size="md" />

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-label ${unread ? 'font-semibold' : 'font-medium'}`}>
              {room.display_name}
            </span>
            <span className="shrink-0 text-metadata text-muted">
              {formatRoomTime(room.last_message?.created_at)}
            </span>
          </span>

          <span className="mt-1 flex items-center justify-between gap-2">
            <span
              className={`truncate text-body ${
                room.has_message ? 'text-muted' : 'text-muted/70'
              }`}
            >
              {formatRoomPreview(room.last_message)}
            </span>

            <span className="flex shrink-0 items-center gap-1.5">
              {isMuted && <IconMute className="h-3.5 w-3.5 text-muted" aria-label="Muted" />}
              {isPinned && <IconPin className="h-3.5 w-3.5 text-muted" aria-label="Pinned" />}
              {unread > 0 && !isMuted && <Badge tone="brand">{unread}</Badge>}
            </span>
          </span>
        </span>
      </NavLink>

      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Actions for ${room.display_name}`}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconMore className="h-4 w-4" aria-hidden="true" />
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute right-2 top-12 z-20 w-44 rounded-lg border border-line bg-surface p-1 shadow-modal"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              togglePin(room.id);
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas"
          >
            <IconPin className="h-4 w-4 text-muted" aria-hidden="true" />
            {isPinned ? 'Unpin' : 'Pin to top'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              toggleMute(room.id);
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas"
          >
            <IconMute className="h-4 w-4 text-muted" aria-hidden="true" />
            {isMuted ? 'Unmute' : 'Mute'}
          </button>
          <p className="border-t border-line px-2.5 pb-1 pt-2 text-metadata text-muted">
            Saved on this device
          </p>
        </div>
      )}
    </li>
  );
}
