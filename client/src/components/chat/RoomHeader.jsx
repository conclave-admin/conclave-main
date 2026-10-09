import { Link } from 'react-router-dom';
import IconArrowLeft from '@/assets/icons/arrow-left.svg?react';
import IconInfo from '@/assets/icons/info.svg?react';

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
  const title = room.display_name || room.name;

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
          <h1 className="truncate text-sm font-bold leading-5 text-ink md:text-base">{title}</h1>
          <span
            className={`h-2 w-2 shrink-0 rounded-full md:hidden ${
              isConnected ? 'bg-success' : 'bg-line'
            }`}
            aria-hidden="true"
          />
        </div>
        <p className="mt-0.5 text-[11px] leading-4 text-muted md:text-xs">
          {room.members?.length || 0} members
          <span className="md:hidden"> · {isConnected ? 'Live' : 'Reconnecting'}</span>
        </p>
      </div>

      <Link
        to={`/chats/${room.id}/info`}
        aria-label="Room information"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink"
      >
        <IconInfo className="h-5 w-5" aria-hidden="true" />
      </Link>
    </div>
  );
}
