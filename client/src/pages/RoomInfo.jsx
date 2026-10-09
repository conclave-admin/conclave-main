import { useParams } from 'react-router-dom';
import EmptyState from '@/components/ui/EmptyState';

/**
 * Room detail — `/chats/:roomId/info`.
 *
 * Stub. This is the route section 5 describes as the right-hand side of the
 * room: members, files, pinned messages, encryption status and moderation.
 * None of it is built, and the pieces that exist on the server (`GET
 * /rooms/:roomId` with members, `GET /messages/:roomId/pinned`) are not enough
 * on their own to fill the panel honestly.
 *
 * It is a stub on its own route rather than omitted, because the room header
 * now links to it. Leaving that link out would mean the members list has no
 * entry point at all — the same gap that made the old sidebar's `/dms` link a
 * dead end.
 */
export default function RoomInfo() {
  const { roomId } = useParams();

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 md:px-10">
      <h1 className="text-h1 text-ink">Room information</h1>
      <p className="mt-2 text-body leading-relaxed text-muted">
        Members, files, pinned messages and moderation controls for this room.
      </p>

      <div className="mt-10 rounded-xl border border-line bg-surface">
        <EmptyState
          title="Not built yet"
          description={`Room ${roomId} is open and its messages are unaffected. This panel is coming in a later phase.`}
        />
      </div>
    </div>
  );
}
