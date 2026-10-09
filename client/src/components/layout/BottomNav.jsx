import { NavLink } from 'react-router-dom';
import { useChats } from '@/contexts/ChatsContext';
import IconDecisions from '@/assets/icons/decisions.svg?react';
import IconHome from '@/assets/icons/home.svg?react';
import IconMember from '@/assets/icons/member.svg?react';
import IconTasks from '@/assets/icons/tasks.svg?react';

const tabs = [
  { to: '/chats', label: 'Chats', Icon: IconHome, end: true },
  { to: '/tasks', label: 'Tasks', Icon: IconTasks },
  { to: '/decisions', label: 'Decisions', Icon: IconDecisions },
  { to: '/profile', label: 'Me', Icon: IconMember },
];

/**
 * The bottom tab bar, below `md`.
 *
 * Four tabs, matching section 5. Notifications is not one of them — it stays
 * as the bell in the header, because a tab bar past four items stops being
 * tappable at a comfortable size and because the bell already carries the
 * unread count. Adding a fifth tab for a link that exists in two other places
 * would trade a working affordance for a crowded one.
 *
 * Each tab reserves a fixed width and truncates rather than wrapping: labels
 * change length with the locale and the active state, and a bar whose items
 * shift width when tapped reads as a layout error.
 */
export default function BottomNav() {
  const { unreadTotal } = useChats();

  return (
    <nav
      aria-label="Primary"
      className="grid shrink-0 grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {tabs.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          end={end}
          to={to}
          className={({ isActive }) =>
            `flex min-h-14 flex-col items-center justify-center gap-1 px-1 transition-colors ${
              isActive ? 'text-brand' : 'text-muted'
            }`
          }
        >
          <span className="relative">
            <Icon className="h-5 w-5" aria-hidden="true" />
            {to === '/chats' && unreadTotal > 0 && (
              <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-metadata font-semibold text-surface">
                {unreadTotal > 99 ? '99+' : unreadTotal}
              </span>
            )}
          </span>
          <span className="max-w-full truncate text-metadata">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
