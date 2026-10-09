import { useRef, useState } from 'react';
// compose.svg, not an "edit" icon: the set has no pencil glyph, and compose and
// edit are the same gesture — a pen writing on a surface. Inventing one asset
// for a single row would break the set's 90-icon style contract for no gain.
import IconCompose from '@/assets/icons/compose.svg?react';
import IconDecisions from '@/assets/icons/decisions.svg?react';
import IconDelete from '@/assets/icons/delete.svg?react';
import IconMore from '@/assets/icons/more.svg?react';
import IconReply from '@/assets/icons/reply.svg?react';
import IconTasks from '@/assets/icons/tasks.svg?react';
import PopoverMenu from '@/components/ui/PopoverMenu';

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
 * Promote and flag-as-task are open to every member, because both create
 * something new rather than change what exists, and both carry the message id
 * back to the server so the decision or task stays linked to where it came from.
 * They live here rather than only on the top-level pages because a decision is
 * almost always remembered as "that message in #deployments" — finding it again
 * in a board is the hard part, not writing it down.
 *
 * The menu is a sibling of the message content rather than a wrapper around it,
 * so the row stays selectable and the menu cannot swallow a text selection.
 *
 * @param {object} message
 * @param {string} viewerId
 * @param {boolean} isAdmin - the viewer's role in this room
 * @param {{ onReply: Function, onEdit: Function, onDelete: Function, onPromote: Function, onFlagTask: Function }} handlers
 */
export default function MessageActions({
  message,
  viewerId,
  isAdmin,
  onReply,
  onEdit,
  onDelete,
  onPromote,
  onFlagTask,
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  const isMine = message.sender_id === viewerId;

  if (message.is_deleted) return null;

  const items = [
    { key: 'reply', label: 'Reply', Icon: IconReply, onClick: onReply },
    ...(isMine
      ? [{ key: 'edit', label: 'Edit', Icon: IconCompose, onClick: onEdit }]
      : []),
    { key: 'promote', label: 'Promote to decision', Icon: IconDecisions, onClick: onPromote },
    { key: 'task', label: 'Flag as task', Icon: IconTasks, onClick: onFlagTask },
    ...(isMine || isAdmin
      ? [{ key: 'delete', label: 'Delete', Icon: IconDelete, onClick: onDelete, danger: true }]
      : []),
  ];

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Message actions"
        className="grid h-7 w-7 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconMore className="h-4 w-4" aria-hidden="true" />
      </button>

      <PopoverMenu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        align="end"
        label="Message actions"
        className="w-52"
      >
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
      </PopoverMenu>
    </div>
  );
}
