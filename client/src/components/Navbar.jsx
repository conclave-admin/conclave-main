import { NavLink, useNavigate, useSearchParams } from 'react-router-dom';
import { useNotifications } from '@/contexts/NotificationsContext';
import IconMenu from '../assets/icons/menu.svg?react';
import IconNotify from '../assets/icons/notify.svg?react';
import IconSearch from '../assets/icons/search.svg?react';

/**
 * The header.
 *
 * The search field writes `?q=` and always lands on `/chats`, because the
 * parameter is only meaningful to the chat list. Typing it while a room is
 * open therefore leaves the room — which is right: the alternative is writing
 * `?q=` onto a route that ignores it, so the field looks live and does
 * nothing. Navigation uses `replace` so a ten-character query does not become
 * ten history entries.
 *
 * The bell is a link rather than a button with no handler. It had no
 * destination before, which made it a control that does nothing — the worst
 * possible outcome for something that looks like the way to reach
 * notifications. The sidebar now carries that route too, and this is the
 * second entry point.
 *
 * The badge is the notifications unread count, not the room unread total. An
 * earlier version used the room total because `GET /notifications` was thought
 * to have no aggregate; it does — the controller counts unseen rows separately
 * from the page so the badge is not capped at the page size. The two numbers
 * count different things and only one of them belongs on a bell.
 *
 * @param {React.ReactNode|null} roomHeader - a richer title supplied by the route
 * @param {() => void} onMenuClick
 */
export default function Navbar({ roomHeader = null, onMenuClick }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { unreadCount } = useNotifications();

  const query = params.get('q') || '';

  const setQuery = (value) => {
    const next = new URLSearchParams();
    if (value) next.set('q', value);
    navigate(`/chats?${next.toString()}`, { replace: true });
  };

  return (
    <header className="border-b border-line bg-surface">
      <nav className="flex h-16 items-center gap-4 pl-4 pr-7">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open menu"
          className="flex h-6 w-6 shrink-0 items-center justify-center md:hidden"
        >
          <IconMenu className="h-6 w-6 text-ink" />
        </button>

        <p className="min-w-0 flex-1 truncate text-h2 text-ink">
          {roomHeader || 'Workspace overview'}
        </p>

        <div className="flex shrink-0 items-center gap-4">
          <label className="relative hidden md:block">
            <span className="sr-only">Search chats</span>
            <IconSearch
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              className="min-h-10 w-48 rounded-lg border border-line bg-canvas pl-9 pr-3 text-body text-ink outline-none transition-shadow placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/15 lg:w-64"
            />
          </label>

          <NavLink
            to="/notifications"
            aria-label={
              unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'
            }
            className="relative flex h-6 w-6 items-center justify-center"
          >
            <IconNotify className="h-6 w-6 text-ink" />
            {unreadCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-metadata font-semibold text-surface">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </NavLink>
        </div>
      </nav>
    </header>
  );
}
