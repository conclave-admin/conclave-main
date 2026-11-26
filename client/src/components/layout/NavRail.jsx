import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { listTeams } from "@/services/teams.service";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import Logo from "@/components/landing/Logo";
import { useAuth } from "@/contexts/AuthContext";
import { useChats } from "@/contexts/ChatsContext";
import IconDecisions from "@/assets/icons/decisions.svg?react";
import IconMessage from "@/assets/icons/message.svg?react";
import IconRecent from "@/assets/icons/recent.svg?react";
import IconDigest from "@/assets/icons/digest.svg?react";
import IconInbox from "@/assets/icons/work-inbox.svg?react";
import IconProjects from "@/assets/icons/projects.svg?react";
import IconSearch from "@/assets/icons/search.svg?react";
import IconSettings from "@/assets/icons/settings.svg?react";
import IconSignOut from "@/assets/icons/sign-out.svg?react";
import IconTasks from "@/assets/icons/tasks.svg?react";
import IconPublic from "@/assets/icons/public.svg?react";
import IconChevronRight from "@/assets/icons/chevron-right.svg?react";
import IconTeams from "@/assets/icons/teams.svg?react";
import IconCall from "@/assets/icons/call.svg?react";

const navGroups = [
  { label: "Communication", items: [
    { to: "/chats", label: "Chats", Icon: IconMessage, end: false },
    { to: "/teams", label: "Communities", Icon: IconTeams, end: false },
    { to: "/activity", label: "Message activity", Icon: IconRecent },
    { to: "/calls", label: "Calls", Icon: IconCall },
    { to: "/digest", label: "Catch up", Icon: IconDigest },
  ] },
  { label: "Work", items: [
    { to: "/work/inbox", label: "My work", Icon: IconInbox },
    { to: "/tasks", label: "Tasks", Icon: IconTasks },
    { to: "/decisions", label: "Decisions", Icon: IconDecisions },
    { to: "/work", label: "Projects", Icon: IconProjects, end: true },
    { to: "/work/search", label: "Search all", Icon: IconSearch },
  ] },
  { label: "Explore", items: [
    { to: "/discover", label: "Discover rooms", Icon: IconPublic },
  ] },
];

const itemBase =
  "mx-3 flex h-12 shrink-0 items-center rounded-2xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

function RailItem({ to, end, label, Icon, badge = 0, collapsed, onNavigate }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={() => {
        // Let React Router handle the link before the mobile drawer unmounts
        // this rail. Closing synchronously can cancel navigation on touch.
        if (onNavigate) queueMicrotask(() => onNavigate(to));
      }}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        `${itemBase} ${collapsed ? "justify-center" : "gap-3 px-3"} ${
          isActive ? "bg-brand-soft text-brand" : "text-ink hover:bg-canvas"
        }`
      }
    >
      <span className="relative shrink-0">
        <Icon className="h-5 w-5" aria-hidden="true" />
        {collapsed && badge > 0 && (
          <span
            className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-surface"
            aria-hidden="true"
          />
        )}
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1 truncate text-body">{label}</span>
      )}
      {!collapsed && badge > 0 && <Badge tone="brand">{badge}</Badge>}
    </NavLink>
  );
}

/**
 * The primary rail.
 *
 * Collapsed (a 72px icon column) or expanded (labels). Rooms are not listed
 * here: the chat list is the only place they appear, so the screen never shows
 * the same list twice.
 *
 * @param {boolean} [collapsed]
 * @param {() => void} [onNavigate] - closes the mobile drawer after a click
 */
export default function NavRail({
  collapsed = false,
  pinned = false,
  onToggleExpanded,
  onNavigate,
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [teams, setTeams] = useState([]);
  useEffect(() => {
    let live = true;
    listTeams()
      .then((result) => {
        if (live) setTeams(result.teams);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pathname, user?.id]);
  const { unreadTotal } = useChats();
  const displayName = user?.display_name || "Unknown user";

  // Closing the drawer matters as much as signing out: an overlay left open
  // over a signed-out login screen is worse than not signing out.
  const onSignOut = () => {
    onNavigate?.();
    logout();
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain py-4">
      <NavLink
        to="/chats"
        onClick={() => onNavigate?.("/chats")}
        aria-label="Conclave, home"
        className={`mb-6 flex shrink-0 items-center ${collapsed ? "justify-center" : "px-6"}`}
      >
        {collapsed ? <Logo withWordmark={false} /> : <Logo />}
      </NavLink>

      <nav aria-label="Workspace" className="flex flex-col">
        {!collapsed && (
          <div className="mx-3 mb-3">
            <label
              htmlFor="team-switcher"
              className="mb-1 block px-2 text-metadata text-muted"
            >
              TEAM CONTEXT
            </label>
            <select
              id="team-switcher"
              className="min-h-11 w-full rounded-xl border border-line bg-surface px-2 text-body text-ink"
              value={
                pathname.startsWith("/teams/") ? pathname.split("/")[2] : ""
              }
              onChange={(event) => {
                const to = event.target.value
                  ? `/teams/${event.target.value}`
                  : "/teams";
                onNavigate?.(to);
                navigate(to);
              }}
            >
              <option value="">Personal / all teams</option>
              {teams.map((team) => (
                <option value={team.id} key={team.id}>
                  {team.name}
                  {team.archived_at ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {navGroups.map((group, groupIndex) => (
          <section
            key={group.label}
            aria-label={group.label}
            className={groupIndex > 0 ? "mt-3" : ""}
          >
            {collapsed ? (
              groupIndex > 0 && <div className="mx-5 mb-2 border-t border-line" aria-hidden="true" />
            ) : (
              <h2 className="mb-1 px-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                {group.label}
              </h2>
            )}
            <div className="flex flex-col gap-1">
              {group.items.map((item) => (
                <RailItem
                  key={item.to}
                  {...item}
                  badge={item.to === "/chats" ? unreadTotal : 0}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className="mt-auto shrink-0 pt-4">
        <div className="mx-3 mb-3 border-t border-line" />

        {onToggleExpanded && (
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-label={pinned ? "Collapse navigation" : "Keep navigation open"}
            aria-pressed={pinned}
            title={collapsed ? "Keep navigation open" : undefined}
            className={`${itemBase} w-[calc(100%-1.5rem)] text-muted hover:bg-surface hover:text-ink ${collapsed ? "justify-center" : "gap-3 px-3"}`}
          >
            <IconChevronRight
              className={`h-5 w-5 shrink-0 transition-transform ${pinned ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
            {!collapsed && (
              <span className="text-body">
                {pinned ? "Collapse menu" : "Keep menu open"}
              </span>
            )}
          </button>
        )}

        <RailItem
          to="/settings"
          label="Settings"
          Icon={IconSettings}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />

        <NavLink
          to="/profile"
          onClick={() => onNavigate?.("/profile")}
          title={collapsed ? displayName : undefined}
          aria-label={collapsed ? `Profile, ${displayName}` : undefined}
          className={({ isActive }) =>
            `mx-3 mt-1.5 flex h-12 shrink-0 items-center rounded-2xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
              collapsed ? "justify-center" : "gap-3 px-3"
            } ${isActive ? "bg-brand-soft" : "hover:bg-canvas"}`
          }
        >
          <Avatar name={displayName} src={user?.avatar_url} size="sm" />
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label text-ink">
                {displayName}
              </span>
              <span className="mt-1 block text-metadata text-muted">
                View profile
              </span>
            </span>
          )}
        </NavLink>

        <button
          type="button"
          onClick={onSignOut}
          title={collapsed ? "Log out" : undefined}
          aria-label={collapsed ? "Log out" : undefined}
          className={`${itemBase} mt-1.5 w-[calc(100%-1.5rem)] text-ink hover:bg-canvas ${
            collapsed ? "justify-center" : "gap-3 px-3"
          }`}
        >
          <IconSignOut className="h-5 w-5 shrink-0" aria-hidden="true" />
          {!collapsed && <span className="text-body">Log out</span>}
        </button>
      </div>
    </div>
  );
}
