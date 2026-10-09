import EmptyState from '@/components/ui/EmptyState';

/**
 * Placeholder for the chat list.
 *
 * Exists only so the post-auth redirect has somewhere to land. Without it,
 * `/` sends signed-in visitors to `/chats`, the catch-all sends unknown paths
 * back to `/`, and the browser loops until it gives up — which looks exactly
 * like a broken login.
 *
 * Phase 4 replaces this with the real list, using the last_message and
 * unread_count that phase 1 added to `GET /rooms`.
 */
export default function Chats() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-10 md:px-10 lg:px-16">
      <h1 className="text-h1 text-ink">Chats</h1>
      <p className="mt-2 text-body leading-relaxed text-muted">
        Your conversations will live here.
      </p>

      <div className="mt-10 rounded-xl border border-line bg-surface">
        <EmptyState
          title="Nothing here yet"
          description="The chat list is being built. Until then, your rooms and messages are still on the server and nothing has been lost."
        />
      </div>
    </div>
  );
}
