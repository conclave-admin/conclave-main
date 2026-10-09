import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import EmptyState from '@/components/ui/EmptyState';
import Spinner from '@/components/ui/Spinner';
import { useChats } from '@/contexts/ChatsContext';
import CatchUpCard from './CatchUpCard';
import ChatFilters from './ChatFilters';
import ChatRow from './ChatRow';

/**
 * The chat list.
 *
 * Filtering happens here rather than in the service: all of a user's rooms
 * arrive in one request, and four client-side predicates are cheaper and
 * instant, where four server round trips would make the chips feel broken.
 *
 * `type` is what the API calls the room kind. `dm` is the only value with its
 * own chip; groups covers `group`, `department` and everything else, because
 * the list's job is "not a direct message", not "enumerate the schema".
 *
 * Muted rooms stay in the list. Muting suppresses the unread badge — which
 * ChatRow does — it does not hide the conversation, because hiding a room
 * someone is a member of is how a message goes unread for a month.
 */
export default function ChatList() {
  const { rooms, isLoading, error } = useChats();
  // Both the chip and the search field write to the URL, so reading them here
  // keeps one source of truth and lets a filtered view be linked to directly.
  const [params] = useSearchParams();
  const filter = params.get('filter') || '';
  const query = params.get('q') || '';

  const visibleRooms = useMemo(() => {
    let list = rooms;

    if (filter === 'unread') list = list.filter((room) => (room.unread_count || 0) > 0);
    else if (filter === 'groups') list = list.filter((room) => room.type !== 'dm');
    else if (filter === 'dms') list = list.filter((room) => room.type === 'dm');

    const needle = query.trim().toLowerCase();
    if (needle) {
      list = list.filter((room) => (room.display_name || room.name || '').toLowerCase().includes(needle));
    }

    return list;
  }, [rooms, filter, query]);

  const filtered = Boolean(filter || query.trim());

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatFilters />

      <CatchUpCard />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {isLoading && <Spinner label="Loading chats" />}

        {error && (
          <p role="alert" className="m-3 rounded-lg bg-error/10 p-3 text-body text-error">
            {error}
          </p>
        )}

        {!isLoading && !error && visibleRooms.length === 0 && (
          <EmptyState
            title={filtered ? 'Nothing matches' : 'No chats yet'}
            description={
              filtered
                ? 'Try a different filter, or clear the search to see everything.'
                : 'Start a conversation and it will appear here.'
            }
          />
        )}

        {!isLoading && !error && visibleRooms.length > 0 && (
          <ul className="flex flex-col gap-1">
            {visibleRooms.map((room) => (
              <ChatRow key={room.id} room={room} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
