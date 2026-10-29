import { NavLink, useLocation, useMatch } from "react-router-dom";
import { useNotifications } from "@/contexts/NotificationsContext";
import wordmarkUrl from "@/assets/brand/conclave-wordmark.svg";
import IconMenu from "../assets/icons/menu.svg?react";
import IconNotify from "../assets/icons/notify.svg?react";

const TITLES = [
  ["/chats", "Chats"],
  ["/tasks", "Tasks"],
  ["/decisions", "Decisions"],
  ["/digest", "Catch up"],
  ["/notifications", "Notifications"],
  ["/settings", "Settings"],
  ["/profile", "Profile"],
  ["/new", "New chat"],
  ["/work/inbox", "My work"],
  ["/work/search", "Search all"],
  ["/work", "Projects"],
];

function titleFor(pathname) {
  const match = TITLES.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return match ? match[1] : "Conclave";
}

const iconButton =
  "relative grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30";

/**
 * The header.
 *
 * The mobile wordmark stays left; notification and menu controls stay at the
 * far right at every size. On chat routes the room title begins at the chat
 * pane boundary. Below md, an open room replaces the row with its own header.
 *
 * Search lives in the chat list now, next to the thing it filters.
 *
 * @param {React.ReactNode|null} roomHeader - a richer title supplied by the route
 * @param {() => void} onMenuClick
 * @param {string} menuLabel
 */
export default function Navbar({
  roomHeader = null,
  onMenuClick,
  menuLabel = "Open menu",
}) {
  const { pathname } = useLocation();
  const nestedRoomMatch = useMatch("/chats/:roomId/*");
  const roomMatch = useMatch("/chats/:roomId");
  const roomOpen = Boolean(nestedRoomMatch || roomMatch);
  const inChats = pathname.startsWith("/chats");
  const { unreadCount } = useNotifications();

  // Below md an open room shows its own header, unless the page has not
  // supplied one (the room info page), in which case the controls stay.
  const roomOwnsRow = roomOpen && Boolean(roomHeader);

  return (
    <header className="border-b border-line bg-surface">
      <nav
        className={`relative grid h-16 grid-cols-1 items-center ${inChats ? "md:grid-cols-[var(--list-w)_1fr]" : ""}`}
      >
        <div
          className={`flex min-w-0 items-center justify-between px-3 ${roomOwnsRow ? "hidden md:flex" : ""}`}
        >
          <NavLink
            to="/chats"
            aria-label="Conclave, home"
            className="md:hidden"
          >
            <img
              src={wordmarkUrl}
              alt=""
              width="128"
              height="34"
              className="h-8 w-auto"
            />
          </NavLink>

          {!inChats && (
            <div className="ml-2 hidden min-w-0 flex-1 truncate text-h2 text-ink md:block">
              {titleFor(pathname)}
            </div>
          )}
          {inChats && (
            <div className="hidden min-w-0 flex-1 truncate text-h2 text-ink md:block">
              Chats
            </div>
          )}
          <div
            className={`ml-auto flex items-center gap-1 ${inChats ? "md:absolute md:right-2 md:top-1/2 md:z-10 md:-translate-y-1/2" : ""}`}
          >
            <NavLink
              to="/notifications"
              aria-label={
                unreadCount > 0
                  ? `Notifications, ${unreadCount} unread`
                  : "Notifications"
              }
              className={iconButton}
            >
              <IconNotify className="h-6 w-6" aria-hidden="true" />
              {unreadCount > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-metadata font-semibold text-surface">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </NavLink>

            <button
              type="button"
              onClick={onMenuClick}
              aria-label={menuLabel}
              className={iconButton}
            >
              <IconMenu className="h-6 w-6" aria-hidden="true" />
            </button>
          </div>
        </div>

        {inChats && (
          <div
            className={`min-w-0 md:border-l md:border-line md:px-4 ${roomOwnsRow ? "md:pr-24" : ""} ${
              roomOwnsRow ? "px-3" : "hidden md:block"
            }`}
          >
            {roomHeader}
          </div>
        )}
      </nav>
    </header>
  );
}
