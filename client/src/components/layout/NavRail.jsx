import { NavLink } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import Badge from '@/components/ui/Badge';
import EmptyState from '@/components/ui/EmptyState';
import Spinner from '@/components/ui/Spinner';
import { useAuth } from '@/contexts/AuthContext';
import { useChats } from '@/contexts/ChatsContext';
import IconDecisions from '@/assets/icons/decisions.svg?react';
import IconHash from '@/assets/icons/hash.svg?react';
import IconHome from '@/assets/icons/home.svg?react';
import IconInvite from '@/assets/icons/invite.svg?react';
import IconLocked from '@/assets/icons/locked.svg?react';
import IconMember from '@/assets/icons/member.svg?react';
import IconNotify from '@/assets/icons/notify.svg?react';
import IconSettings from '@/assets/icons/settings.svg?react';
import IconTasks from '@/assets/icons/tasks.svg?react';
import IconThread from '@/assets/icons/thread.svg?react';

// Design specifies Hash for public rooms and Lock for private. Nothing in the
// board covers dm | group | department, so thread.svg stands in for those.
function RoomIcon({ room }) {
  if (room.type === 'dm') {
    return <Avatar name={room.display_name} src={room.display_avatar} size="sm" />;
  }
  if (room.type === 'public') return <IconHash className="h-5 w-5 shrink-0" />;
  if (room.type === 'private') return <IconLocked className="h-5 w-5 shrink-0" />;
  return <IconThread className="h-5 w-5 shrink-0" />;
}

// Row pill is 36px (h-9); pitch is set by each nav's gap — 44px for the
// workspace nav, 42px for rooms. The active highlight is 196px wide at a
// 220px sidebar (220 − 12 margin each side).
const rowClass = ({ isActive }) =>
  `mx-3 flex h-9 items-center gap-3 rounded-lg pl-3 text-body transition-colors ${
    isActive ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-canvas'
  }`;

const primaryNav = [
  { to: '/chats', label: 'Chats', Icon: IconHome, end: true },
  { to: '/decisions', label: 'Decisions', Icon: IconDecisions },
  { to: '/tasks', label: 'Tasks', Icon: IconTasks },
  { to: '/digest', label: 'Digest', Icon: IconNotify },
  { to: '/notifications', label: 'Notifications', Icon: IconNotify },
];

/**
 * The primary rail, `md` and up.
 *
 * Every in-app route is reachable from here. That is deliberate: the previous
 * version shipped a link to `/dms` with no matching route and left `/digest`
 * with no entry point at all, so a user could be told a feature exists in the
 * API docs and have no way to reach it in the product.
 *
 * "Invite members" points at `/new` rather than `/settings`. The new-chat
 * screen is where a person is actually found and a conversation started, and
 * there is no invite flow to send someone to — so linking the label at
 * settings would have put a dead end behind the most prominent secondary item.
 *
 * @param {() => void} [onNavigate] - closes the mobile drawer after a click
 */
export default function NavRail({ onNavigate }) {
  const { user } = useAuth();
  const { rooms, isLoading, error, unreadTotal } = useChats();
  const displayName = user?.display_name || 'Unknown user';

  return (
    <div className="flex h-full min-h-0 flex-col pb-4 pt-6">
      <NavLink to="/chats" onClick={onNavigate} className="px-6 text-h2 text-brand">
        CONCLAVE
      </NavLink>

      <p className="mt-10 px-6 text-label uppercase text-muted">Workspace</p>
      <nav className="mt-6 flex flex-col gap-2">
        {primaryNav.map(({ to, label, Icon, end }) => (
          <NavLink key={to} end={end} to={to} onClick={onNavigate} className={rowClass}>
            <Icon className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {to === '/chats' && unreadTotal > 0 && <Badge tone="brand">{unreadTotal}</Badge>}
          </NavLink>
        ))}
      </nav>

      <p className="mt-10 px-6 text-label uppercase text-muted">Rooms</p>
      <nav className="mt-3 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {isLoading && <Spinner label="Loading rooms" />}
        {error && <p className="mx-3 text-metadata text-error">{error}</p>}
        {!isLoading && !error && rooms.length === 0 && (
          <EmptyState title="No rooms yet" description="Rooms you join will appear here." />
        )}
        {rooms.map((room) => (
          <NavLink key={room.id} to={`/chats/${room.id}`} onClick={onNavigate} className={rowClass}>
            <RoomIcon room={room} />
            <span className="min-w-0 flex-1 truncate">{room.display_name || room.name}</span>
            {room.unread_count > 0 && <Badge tone="brand">{room.unread_count}</Badge>}
          </NavLink>
        ))}
      </nav>

      <div className="mt-4">
        <div className="mx-3 border-t border-line" />

        <NavLink to="/profile" onClick={onNavigate} className="mt-5 flex items-start gap-3 px-6">
          <span className="h-10 w-10 shrink-0 rounded-full bg-line" aria-hidden="true" />
          <span className="flex min-w-0 flex-col gap-1 pt-1">
            <span className="truncate text-label text-ink">{displayName}</span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
              <span className="text-metadata text-muted">Available</span>
            </span>
          </span>
        </NavLink>

        <NavLink
          to="/new"
          onClick={onNavigate}
          className="mx-3 mt-4 flex h-9 items-center gap-3 rounded-lg pl-3 text-body text-ink transition-colors hover:bg-canvas"
        >
          <IconInvite className="h-5 w-5 shrink-0" />
          Invite members
        </NavLink>

        <NavLink
          to="/settings"
          onClick={onNavigate}
          className="mx-3 mt-1 flex h-9 items-center gap-3 rounded-lg pl-3 text-body text-ink transition-colors hover:bg-canvas"
        >
          <IconSettings className="h-5 w-5 shrink-0" />
          Settings
        </NavLink>
      </div>
    </div>
  );
}
