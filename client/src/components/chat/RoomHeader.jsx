import { useState } from "react";
import ConversationSearch from "./ConversationSearch";
import IconSearch from "@/assets/icons/search.svg?react";
import { useRealtime } from "../../contexts/RealtimeContext";
import { Link } from "react-router-dom";
import IconArrowLeft from "@/assets/icons/arrow-left.svg?react";
import IconInfo from "@/assets/icons/info.svg?react";
import Avatar from "@/components/ui/Avatar";
import { useAuth } from "@/contexts/AuthContext";
import { usePresence } from "@/contexts/PresenceContext";

/**
 * The header shown while a room is open.
 *
 * Uses `display_name` from the enriched rooms response rather than `name`.
 * For a DM the room has no title of its own — the backend returns the other
 * member's identity — so reading `name` would put a slug or a null in the
 * header of the most personal view in the product.
 *
 * The back link is mobile-only because it has no job at `md` and up: there the
 * list is still on screen beside the conversation, and a back control that
 * goes nowhere would be the second dead affordance in this header.
 *
 * The info button is the entry point to the room detail route. It was missing,
 * which left `/rooms/:id` without any way to reach members, files or
 * moderation — the entire right-hand side of section 5.
 *
 * @param {object} room
 * @param {boolean} isConnected
 */
export default function RoomHeader({ room, isConnected }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const { isOnline } = useRealtime();
  const title = room.display_name || room.name;
  const { user } = useAuth();
  const { isOnlineIn, getPresence, labelFor } = usePresence();
  const isDm = room.type === "dm";
  const peer = isDm
    ? room.members?.find((member) => member.id !== user?.id)
    : null;
  const peerActive = Boolean(peer && isOnlineIn(room.id, peer.id));

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Link
        to="/chats"
        aria-label="Back to chats"
        className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-canvas md:hidden"
      >
        <IconArrowLeft className="h-5 w-5" aria-hidden="true" />
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isDm && (
            <Avatar
              name={title}
              src={peer?.avatar_url}
              size="sm"
              presence={
                getPresence(room.id, peer?.id) === "unknown"
                  ? null
                  : peerActive
                    ? "online"
                    : "offline"
              }
            />
          )}
          <h1 className="truncate text-sm font-bold leading-5 text-ink md:text-base">
            {title}
          </h1>
        </div>
        <p className="mt-0.5 text-[11px] leading-4 text-muted md:text-xs">
          {isDm
            ? labelFor(room.id, peer?.id)
            : `${room.members?.length || 0} members`}
          {isDm && peer?.custom_status && <span> · {peer.custom_status}</span>}
          <span hidden={isOnline && isConnected}>
            {" "}
            ·{" "}
            {!isOnline
              ? "Offline · messages queued"
              : isConnected
                ? ""
                : "Connecting…"}
          </span>
        </p>
      </div>

      <button
        type="button"
        aria-label="Search conversation"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted hover:bg-canvas"
        onClick={() => setSearchOpen(true)}
      >
        <IconSearch className="h-5 w-5" />
      </button>
      <ConversationSearch
        room={room}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
      <Link
        to={`/chats/${room.id}/info`}
        aria-label={isDm ? "Conversation details" : "Room information"}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink"
      >
        <IconInfo className="h-5 w-5" aria-hidden="true" />
      </Link>
    </div>
  );
}
