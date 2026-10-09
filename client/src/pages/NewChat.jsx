import EmptyState from '@/components/ui/EmptyState';

/**
 * New chat / find people — `/new`.
 *
 * Stub. This is where the sidebar's "Invite members" item, the mobile compose
 * button and the "start a conversation" call to action all land.
 *
 * The server already supports what this screen needs — `GET /users/search?q=`
 * for finding a person, `POST /rooms` with `type: 'dm'` to open the
 * conversation — so this is a UI gap, not an API gap. It is left as a stub
 * rather than half-built because a search box that finds people and cannot
 * open a conversation with them is a worse thing to ship than an honest
 * "not built yet".
 */
export default function NewChat() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 md:px-10">
      <h1 className="text-h1 text-ink">New chat</h1>
      <p className="mt-2 text-body leading-relaxed text-muted">
        Start a direct message, create a group, or find someone to invite.
      </p>

      <div className="mt-10 rounded-xl border border-line bg-surface">
        <EmptyState
          title="Not built yet"
          description="Starting a new conversation is coming in a later phase. Your existing rooms and messages are unaffected."
        />
      </div>
    </div>
  );
}
