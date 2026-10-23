import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { ChatsProvider } from "@/contexts/ChatsContext";
import { NotificationsProvider } from "@/contexts/NotificationsContext";
import { PresenceProvider } from "@/contexts/PresenceContext";
import useMediaQuery from "@/hooks/useMediaQuery";
import usePersistentState from "@/hooks/usePersistentState";
import Navbar from "../Navbar";
import BottomNav from "./BottomNav";
import NavRail from "./NavRail";
import { useChats } from "@/contexts/ChatsContext";

function QuickSwitcher({ open, onClose }) {
  const { rooms } = useChats();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  if (!open) return null;
  const matches = rooms
    .filter((room) =>
      (room.display_name || room.name || "")
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 8);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-ink/40 px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-modal"
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          className="w-full border-b border-line bg-surface px-4 py-3 text-body text-ink outline-none"
        />
        <ul className="max-h-[50vh] overflow-y-auto p-2">
          {matches.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                onClick={() => {
                  navigate(`/chats/${room.id}`);
                  onClose();
                }}
                className="w-full rounded-lg px-3 py-2 text-left text-body text-ink hover:bg-canvas"
              >
                {room.display_name || room.name}
              </button>
            </li>
          ))}
          {!matches.length && (
            <li className="px-3 py-4 text-body text-muted">
              No matching conversations
            </li>
          )}
        </ul>
        <p className="border-t border-line px-4 py-2 text-metadata text-muted">
          Ctrl+K to switch · Esc to close
        </p>
      </section>
    </div>
  );
}

/**
 * The app shell: rail, header, content.
 *
 * At md and up the rail is a slim icon column that the header's sidebar button
 * expands to show labels, and the choice is remembered. Below md the rail is a
 * drawer opened by the same button. Each route owns its own overflow, so the
 * chat list and the timeline scroll independently.
 *
 * `setRoomHeader` is how a route replaces the header title with something
 * richer than a string.
 */
export default function AppShell() {
  const [roomHeader, setRoomHeader] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = usePersistentState(
    "conclave.sidebar.expanded",
    false,
  );
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");

  // Growing the window past md with the drawer open would leave an overlay on a
  // layout that no longer has one.
  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSwitcherOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setDrawerOpen(false);
        setSwitcherOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const toggleSidebar = () => {
    if (isDesktop) setExpanded((value) => !value);
    else setDrawerOpen(true);
  };

  const sidebarLabel = isDesktop
    ? expanded
      ? "Collapse sidebar"
      : "Expand sidebar"
    : "Open menu";

  return (
    // Every provider here sits at the shell rather than at the root for the
    // same reason: each needs a valid session, and at the root they would all
    // fire on the landing page and fail for everyone who is not signed in.
    // PresenceProvider is outermost because it reads useRealtime; the other two
    // are free to nest in either order, since neither depends on the other.
    <PresenceProvider>
      <NotificationsProvider>
        <ChatsProvider>
          <div
            style={{ "--rail-w": expanded ? "240px" : "72px" }}
            className="grid h-dvh min-h-0 grid-cols-1 bg-canvas text-ink md:grid-cols-[var(--rail-w)_1fr] motion-safe:md:transition-[grid-template-columns] motion-safe:md:duration-200"
          >
            <QuickSwitcher
              open={switcherOpen}
              onClose={() => setSwitcherOpen(false)}
            />
            <aside className="hidden min-h-0 border-r border-line bg-surface md:block">
              <NavRail collapsed={!expanded} />
            </aside>

            {/* grid-cols-1 is the grid-blowout guard: without it one long title
                widens the whole shell. */}
            <div className="grid min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto]">
              <Navbar
                roomHeader={roomHeader}
                onMenuClick={toggleSidebar}
                menuLabel={sidebarLabel}
              />
              <main className="min-h-0 min-w-0 overflow-hidden bg-surface">
                <Outlet context={{ setRoomHeader }} />
              </main>
              <BottomNav />
            </div>

            {drawerOpen && (
              <div className="fixed inset-0 z-50 md:hidden">
                <div
                  className="absolute inset-0 overscroll-contain bg-ink/40"
                  onClick={() => setDrawerOpen(false)}
                  aria-hidden="true"
                />
                <div className="absolute left-0 top-0 h-full w-[min(280px,85vw)] overscroll-contain border-r border-line bg-surface shadow-modal">
                  <NavRail onNavigate={() => setDrawerOpen(false)} />
                </div>
              </div>
            )}
          </div>
        </ChatsProvider>
      </NotificationsProvider>
    </PresenceProvider>
  );
}
