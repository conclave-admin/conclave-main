import useExpiryClock from "../../hooks/useExpiryClock";
import { readDraft } from "../../lib/drafts";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { api } from "@/lib/api";
import { useRealtime } from "@/contexts/RealtimeContext";
import { subscribeToRoom } from "@/lib/roomSubscriptions";
import { useEffect, useRef, useState } from "react";
import { useNavigate, NavLink } from "react-router-dom";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import IconMore from "@/assets/icons/more-vertical.svg?react";
import IconMute from "@/assets/icons/mute.svg?react";
import IconPin from "@/assets/icons/pin.svg?react";
import IconArchive from "@/assets/icons/archive.svg?react";
import { useChats } from "@/contexts/ChatsContext";
import { formatRoomPreview, formatRoomTime } from "@/lib/roomMeta";
import PopoverMenu from "@/components/ui/PopoverMenu";
import { useAuth } from "@/contexts/AuthContext";

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
  const {
    refresh,
    pinned,
    muted,
    archived,
    typingByRoom,
    recordingByRoom,
    togglePin,
    toggleMute,
    toggleArchive,
  } = useChats();
  const { user } = useAuth();
  const [draft, setDraft] = useState(() => readDraft(user?.id, room.id));
  useEffect(() => {
    const update = () => setDraft(readDraft(user?.id, room.id));
    update();
    window.addEventListener("conclave:drafts-changed", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("conclave:drafts-changed", update);
      window.removeEventListener("storage", update);
    };
  }, [user?.id, room.id]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();
  const { socket } = useRealtime();
  const [actionError, setActionError] = useState("");
  const [deleting, setDeleting] = useState(false);
  useEffect(
    () => (socket ? subscribeToRoom(socket, room.id) : undefined),
    [socket, room.id],
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef(null);

  const isPinned = pinned.includes(room.id);
  const isMuted = muted.includes(room.id);
  const isArchived = archived.includes(room.id);
  useExpiryClock([room.last_message]);
  const lastMessage =
    room.last_message?.expires_at &&
    new Date(room.last_message.expires_at) <= new Date()
      ? null
      : room.last_message;
  const unread = room.unread_count || 0;

  return (
    <li className="relative">
      {actionError && (
        <p role="alert" className="text-error text-metadata">
          {actionError}
        </p>
      )}
      {/* No markSeen here: Room does it on open, which covers the rail, a
          deep link and the back button too — not just this click. */}
      <NavLink
        to={`/chats/${room.id}`}
        className={({ isActive }) =>
          `chat-row flex items-center gap-3.5 rounded-xl px-3 py-3 pr-10 transition-colors ${
            isActive ? "bg-brand-soft" : "hover:bg-canvas"
          }`
        }
      >
        <Avatar name={room.display_name} src={room.display_avatar} size="md" />

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate text-label ${unread ? "font-semibold" : "font-medium"}`}
            >
              {room.display_name}
            </span>
            <span className="shrink-0 text-metadata text-muted">
              {formatRoomTime(room.last_message?.created_at)}
            </span>
          </span>

          <span className="mt-1 flex items-center justify-between gap-2">
            <span
              className={`truncate text-body ${
                room.has_message ? "text-muted" : "text-muted/70"
              }`}
            >
              {draft.text ? (
                <>
                  <strong className="text-brand">Draft: </strong>
                  {draft.text}
                </>
              ) : recordingByRoom.get(room.id)?.size ? (
                "recording a voice message…"
              ) : typingByRoom.get(room.id)?.size ? (
                "typing…"
              ) : room.type !== "dm" &&
                room.last_message?.sender_id !== user?.id &&
                room.last_message?.sender_name ? (
                `${room.last_message.sender_name}: ${formatRoomPreview(lastMessage)}`
              ) : (
                formatRoomPreview(lastMessage)
              )}
            </span>

            <span className="flex shrink-0 items-center gap-1.5">
              {room.last_message?.has_mention && (
                <span
                  className="text-metadata font-semibold text-brand"
                  aria-label="You were mentioned"
                >
                  @
                </span>
              )}
              {isMuted && (
                <IconMute
                  className="h-3.5 w-3.5 text-muted"
                  aria-label="Muted"
                />
              )}
              {isPinned && (
                <IconPin
                  className="h-3.5 w-3.5 text-muted"
                  aria-label="Pinned"
                />
              )}
              {unread > 0 && !isMuted && <Badge tone="brand">{unread}</Badge>}
            </span>
          </span>
        </span>
      </NavLink>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Actions for ${room.display_name}`}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconMore className="h-4 w-4" aria-hidden="true" />
      </button>

      <Modal
        open={confirmDelete}
        title="Delete this chat?"
        onClose={() => !deleting && setConfirmDelete(false)}
        closeDisabled={deleting}
      >
        <p className="text-body text-muted">
          This clears your existing history and hides this chat on your devices.
          Other people keep their messages. New messages bring it back. Group
          membership and pending sends are kept.
        </p>
        {actionError && (
          <p role="alert" className="mt-3 text-error">
            {actionError}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <Button
            variant="secondary"
            disabled={deleting}
            onClick={() => setConfirmDelete(false)}
          >
            Keep chat
          </Button>
          <Button
            disabled={deleting}
            onClick={async () => {
              setDeleting(true);
              setActionError("");
              try {
                await api.delete(`/rooms/${room.id}/chat`);
                await refresh();
                setConfirmDelete(false);
                navigate("/chats");
              } catch (e) {
                setActionError(
                  e.response?.data?.message ||
                    "Could not delete chat. Try again when connected.",
                );
              } finally {
                setDeleting(false);
                setMenuOpen(false);
              }
            }}
          >
            {deleting ? "Deleting…" : "Delete chat for me"}
          </Button>
        </div>
      </Modal>
      <PopoverMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        triggerRef={triggerRef}
        align="end"
        label={`Actions for ${room.display_name}`}
        className="w-44"
      >
        {room.last_message?._previewState && (
          <button
            type="button"
            role="menuitem"
            className="w-full px-3 py-2 text-left text-body text-brand"
            onClick={() => {
              setMenuOpen(false);
              room.last_message._previewState === "keys"
                ? navigate("/settings#security-recovery")
                : refresh();
            }}
          >
            {room.last_message._previewState === "keys"
              ? "Restore message access"
              : "Retry message preview"}
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          disabled={deleting}
          className="w-full rounded-md px-2.5 py-2 text-left text-body text-error"
          onClick={() => {
            setMenuOpen(false);
            setActionError("");
            setConfirmDelete(true);
          }}
        >
          Delete chat
        </button>
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
          {isPinned ? "Unpin" : "Pin to top"}
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
          {isMuted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            toggleArchive(room.id);
            setMenuOpen(false);
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas"
        >
          <IconArchive className="h-4 w-4 text-muted" aria-hidden="true" />
          {isArchived ? "Unarchive" : "Archive"}
        </button>
        <p className="border-t border-line px-2.5 pb-1 pt-2 text-metadata text-muted">
          Saved to your account
        </p>
      </PopoverMenu>
    </li>
  );
}
