import { useEffect } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Spinner from '@/components/ui/Spinner';
import { useNotifications } from '@/contexts/NotificationsContext';

// Type-to-display mapping lives here, not in the fixtures and not in the
// service: the server sends a bare type, and display copy is presentation.
// Five types exist (notification.service.js MESSAGE_TARGET_TYPES and
// ROOM_TARGET_TYPES); an unknown one still renders rather than throwing,
// because a new server-side type should not blank this page.
const TYPES = {
  mention: { label: 'Mention', dot: 'bg-brand' },
  new_message: { label: 'New message', dot: 'bg-muted' },
  file_uploaded: { label: 'File shared', dot: 'bg-brand' },
  room_invite: { label: 'Room invite', dot: 'bg-success' },
  member_joined: { label: 'Member joined', dot: 'bg-success' },
};

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
];

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Row({ notification, onOpen }) {
  const { label, dot } = TYPES[notification.type] || { label: 'Update', dot: 'bg-muted' };
  const context = notification.context || {};
  const unread = !notification.seen;

  return (
    <button
      type="button"
      onClick={() => onOpen(notification)}
      className={`flex w-full items-start gap-3 border-b border-line px-4 py-3.5 text-left transition-colors last:border-b-0 hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none ${
        unread ? 'bg-brand-soft/30' : ''
      }`}
    >
      <span
        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${unread ? 'bg-brand' : dot}`}
        aria-hidden="true"
      />

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className={`truncate text-label ${unread ? 'text-ink' : 'text-muted'}`}>
            {label}
          </span>
          <span className="shrink-0 text-metadata text-muted">
            {formatTime(notification.created_at)}
          </span>
        </span>

        {/* actor_name is who caused it; message_preview is what they said.
            A room-targeted type has no message, so preview is null rather
            than empty — render the room name instead of a blank line. */}
        <span className="mt-0.5 block truncate text-body text-ink">
          {context.actor_name ? `${context.actor_name} in ${context.room_name || 'a room'}` : context.room_name || 'A room'}
        </span>

        {context.message_preview && (
          <span className="mt-0.5 block truncate text-metadata text-muted">
            {context.message_preview}
          </span>
        )}
      </span>

      {unread && <span className="sr-only">Unread</span>}
    </button>
  );
}

/**
 * The notifications feed.
 *
 * Opening a row marks it seen and navigates to its room — one gesture, because
 * a notification that requires a second click to clear is a notification the
 * user has to manage rather than read.
 *
 * There is no per-message route, so a mention opens its room rather than
 * scrolling to the message. That is the honest limit of the current routing,
 * not an omission: inventing an anchor that does not resolve would land the
 * reader at the top of the room anyway, with a broken URL besides.
 */
export default function Notifications() {
  const navigate = useNavigate();
  const { setRoomHeader } = useOutletContext();
  const [params, setParams] = useSearchParams();
  const {
    notifications,
    unreadCount,
    nextCursor,
    isLoading,
    error,
    markOne,
    markAll,
    loadMore,
  } = useNotifications();

  const filter = params.get('filter') === 'unread' ? 'unread' : 'all';

  useEffect(() => {
    setRoomHeader(unreadCount > 0 ? `Notifications (${unreadCount})` : 'Notifications');
    return () => setRoomHeader(null);
  }, [setRoomHeader, unreadCount]);

  const setFilter = (key) => {
    const next = new URLSearchParams();
    if (key !== 'all') next.set('filter', key);
    setParams(next);
  };

  const visible = filter === 'unread' ? notifications.filter((n) => !n.seen) : notifications;

  const handleOpen = (notification) => {
    markOne(notification.id);
    if (notification.context?.room_id) navigate(`/chats/${notification.context.room_id}`);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-6 md:px-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1" role="group" aria-label="Filter notifications">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={`rounded-full px-3.5 py-1.5 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                filter === key ? 'bg-brand text-surface' : 'text-muted hover:bg-canvas hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <Button variant="secondary" onClick={markAll} disabled={unreadCount === 0}>
          Mark all as read
        </Button>
      </div>

      <div className="mt-5 pb-8">
        {isLoading && <Spinner label="Loading notifications" />}

        {error && (
          <p role="alert" className="rounded-lg bg-error/10 p-4 text-body text-error">
            {error}
          </p>
        )}

        {!isLoading && !error && visible.length === 0 && (
          <div className="rounded-xl border border-dashed border-line">
            <EmptyState
              title={filter === 'unread' ? 'You are all caught up' : 'No notifications yet'}
              description={
                filter === 'unread'
                  ? 'Nothing unread. Mentions, new messages and room invitations will appear here.'
                  : 'Mentions, new messages and room invitations will appear here.'
              }
            />
          </div>
        )}

        {!isLoading && !error && visible.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {visible.map((notification) => (
              <Row key={notification.id} notification={notification} onOpen={handleOpen} />
            ))}
          </div>
        )}

        {nextCursor && filter === 'all' && !isLoading && (
          <div className="mt-5 flex justify-center">
            <Button variant="secondary" onClick={loadMore}>
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
