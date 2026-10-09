import { useEffect, useRef, useState } from 'react';
// compose.svg, not an "edit" icon: the set has no pencil glyph, and compose and
// edit are the same gesture — a pen writing on a surface. Inventing one asset
// for a single row would break the set's 90-icon style contract for no gain.
import IconCompose from '@/assets/icons/compose.svg?react';
import IconDelete from '@/assets/icons/delete.svg?react';
import IconMore from '@/assets/icons/more.svg?react';
import IconReply from '@/assets/icons/reply.svg?react';

/**
 * Per-message actions.
 *
 * Edit is the author's alone and the server enforces that with no time limit —
 * so it is not shown on anyone else's message. Delete is broader: author or
 * room admin, because moderation has to be able to act on a message its author
 * will not remove. Both are hidden rather than disabled when unavailable,
 * because a greyed-out Delete beside every message is noise for the ninety-nine
 * percent of the time nobody can use it.
 *
 * The menu is a sibling of the message content rather than a wrapper around it,
 * so the row stays selectable and the menu cannot swallow a text selection.
 *
 * @param {object} message
 * @param {string} viewerId
 * @param {boolean} isAdmin - the viewer's role in this room
 * @param {{ onReply: Function, onEdit: Function, onDelete: Function }} handlers
 */
export default function MessageActions({ message, viewerId, isAdmin, onReply, onEdit, onDelete }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  const isMine = message.sender_id === viewerId;

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event) => {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  if (message.is_deleted) return null;

  const items = [
    { key: 'reply', label: 'Reply', Icon: IconReply, onClick: onReply },
    ...(isMine
      ? [{ key: 'edit', label: 'Edit', Icon: IconCompose, onClick: onEdit }]
      : []),
    ...(isMine || isAdmin
      ? [{ key: 'delete', label: 'Delete', Icon: IconDelete, onClick: onDelete, danger: true }]
      : []),
  ];

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Message actions"
        className="grid h-7 w-7 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconMore className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-8 z-20 w-36 rounded-lg border border-line bg-surface p-1 shadow-modal">
          {items.map(({ key, label, Icon, onClick, danger }) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onClick();
              }}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body transition-colors hover:bg-canvas ${
                danger ? 'text-error' : 'text-ink'
              }`}
            >
              <Icon className={`h-4 w-4 ${danger ? 'text-error' : 'text-muted'}`} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
