import { useRef, useState } from "react";
// compose.svg, not an "edit" icon: the set has no pencil glyph, and compose and
// edit are the same gesture — a pen writing on a surface. Inventing one asset
// for a single row would break the set's 90-icon style contract for no gain.
import IconCompose from "@/assets/icons/compose.svg?react";
import IconCopy from "@/assets/icons/copy.svg?react";
import IconDecisions from "@/assets/icons/decisions.svg?react";
import IconDelete from "@/assets/icons/delete.svg?react";
import IconMore from "@/assets/icons/more.svg?react";
import IconPin from "@/assets/icons/pin.svg?react";
import IconForward from "@/assets/icons/forward.svg?react";
import IconReply from "@/assets/icons/reply.svg?react";
import IconStar from "@/assets/icons/star.svg?react";
import IconTasks from "@/assets/icons/tasks.svg?react";
import IconInfo from "@/assets/icons/info.svg?react";
import IconThread from "@/assets/icons/thread.svg?react";
import PopoverMenu from "@/components/ui/PopoverMenu";
import { REACTION_EMOJI } from "@/lib/messageMeta";

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
 * The trigger sits beside the message body without taking layout space; the
 * popover is portalled so it is not clipped by the scrolling timeline.
 *
 * @param {object} message
 * @param {string} viewerId
 * @param {boolean} isAdmin - the viewer's role in this room
 * Pinning is offered here too, not only in the panel. The panel is for finding
 * pins you already have; this is where a pin starts. A message you have to
 * scroll back for to pin is one you will forget to pin.
 *
 *   Pin for everyone  the room-wide pin, shown in the panel
 *   Bookmark for me   personal, and the only one removable from here, because
 *                     the panel deliberately does not show personal bookmarks
 *
 * A room pin that belongs to somebody else is not offered at all — the server
 * answers 409 naming the holder, but a menu item that can only ever fail is
 * worse than no menu item.
 *
 * @param {{ onReply: Function, onEdit: Function, onDelete: Function, onPromote: Function, onFlagTask: Function, onPin: Function, onUnpin: Function }} handlers
 */
export default function MessageActions({
  message,
  viewerId,
  isAdmin,
  open,
  onOpenChange,
  anchorRef,
  align = "end",
  onToggleReaction,
  onMessageInfo,
  onReply,
  onEdit,
  onDelete,
  onPromote,
  onFlagTask,
  onPin,
  onUnpin,
  onOpenThread,
  onForward,
}) {
  const triggerRef = useRef(null);
  const setOpen = (value) =>
    onOpenChange(typeof value === "function" ? value(open) : value);

  // The kebab is hidden on touch, so there the menu anchors to the message.
  const isTouch =
    typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;
  const menuAnchor = isTouch && anchorRef ? anchorRef : triggerRef;

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      // Clipboard blocked (plain http, or permission denied). Nothing to do.
    }
  };

  const isMine = message.sender_id === viewerId;

  if (message.is_deleted) return null;

  // The `pins` object the server attaches to every message: `room` is shared
  // truth, `mine` is this viewer's own pins. Both are needed to know which of
  // the four pin actions apply.
  const roomPin = message.pins?.room || null;
  const myPins = message.pins?.mine || [];
  const holdsRoomPin = myPins.includes("room") || roomPin?.user_id === viewerId;
  // A room admin can take back somebody else's room pin, matching the server.
  const mayUnpinRoom = holdsRoomPin || isAdmin;

  const items = [
    isMine &&
      onMessageInfo && {
        key: "info",
        label: "Message info",
        Icon: IconInfo,
        onClick: onMessageInfo,
      },
    {
      key: "thread",
      label: "Open thread",
      Icon: IconThread,
      onClick: onOpenThread,
    },
    { key: "reply", label: "Reply", Icon: IconReply, onClick: onReply },
    onForward &&
      !message.poll && {
        key: "forward",
        label: "Forward",
        Icon: IconForward,
        onClick: onForward,
      },
    message.content && {
      key: "copy",
      label: "Copy text",
      Icon: IconCopy,
      onClick: copyText,
    },
    // Edit is omitted on a poll: its question IS the message content, so
    // editing the text would silently change what the recorded votes answer,
    // and the server rejects it outright with 400.
    ...(isMine && !message.poll
      ? [{ key: "edit", label: "Edit", Icon: IconCompose, onClick: onEdit }]
      : []),
    {
      key: "promote",
      label: "Promote to decision",
      Icon: IconDecisions,
      onClick: onPromote,
    },
    {
      key: "task",
      label: "Flag as task",
      Icon: IconTasks,
      onClick: onFlagTask,
    },
    !roomPin && {
      key: "pin-room",
      label: "Pin for everyone",
      Icon: IconPin,
      onClick: () => onPin(message, "room"),
    },
    roomPin &&
      mayUnpinRoom && {
        key: "unpin-room",
        label: "Unpin for everyone",
        Icon: IconPin,
        onClick: () => onUnpin(message, "room"),
      },
    !myPins.includes("user") && {
      key: "bookmark",
      label: "Bookmark for me",
      Icon: IconStar,
      onClick: () => onPin(message, "user"),
    },
    myPins.includes("user") && {
      key: "unbookmark",
      label: "Remove my bookmark",
      Icon: IconStar,
      onClick: () => onUnpin(message, "user"),
    },
    ...(isMine || isAdmin
      ? [
          {
            key: "delete",
            label: "Delete",
            Icon: IconDelete,
            onClick: onDelete,
            danger: true,
          },
        ]
      : []),
    // Spreading here rather than `.filter(Boolean)` inline: a false branch above
    // is a skipped item, and skipping is cheaper to read than a filter.
  ].filter(Boolean);

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
        followScroll
        onClose={() => setOpen(false)}
        triggerRef={menuAnchor}
        align={align}
        label="Message actions"
        className="w-52"
      >
        <div
          role="group"
          aria-label="React to this message"
          className="mb-1 flex justify-between gap-1 border-b border-line px-1 pb-1.5 pt-0.5"
        >
          {REACTION_EMOJI.map((emoji) => {
            const already = message.reactions?.find(
              (r) => r.emoji === emoji,
            )?.reacted;
            return (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                aria-pressed={already}
                onClick={() => {
                  setOpen(false);
                  onToggleReaction(emoji);
                }}
                className={`grid h-9 w-9 place-items-center rounded-lg text-body transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                  already ? "bg-brand-soft" : ""
                }`}
              >
                <span aria-hidden="true">{emoji}</span>
                <span className="sr-only">
                  {already ? `Remove ${emoji} reaction` : `React with ${emoji}`}
                </span>
              </button>
            );
          })}
        </div>

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
              danger ? "text-error" : "text-ink"
            }`}
          >
            <Icon
              className={`h-4 w-4 ${danger ? "text-error" : "text-muted"}`}
              aria-hidden="true"
            />
            {label}
          </button>
        ))}
      </PopoverMenu>
    </div>
  );
}
