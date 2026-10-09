import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { ChatsProvider } from '@/contexts/ChatsContext';
import { NotificationsProvider } from '@/contexts/NotificationsContext';
import { PresenceProvider } from '@/contexts/PresenceContext';
import Navbar from '../Navbar';
import BottomNav from './BottomNav';
import NavRail from './NavRail';

/**
 * The app shell.
 *
 * Three panes at `md` and up — rail, header, content — and the same three
 * collapsed below it: the rail becomes a drawer, the header keeps its menu
 * button, and a bottom tab bar takes over navigation. The content area never
 * scrolls as a page; each route owns its own overflow, which is what lets the
 * chat list and the message timeline scroll independently instead of fighting
 * over one scrollbar.
 *
 * The `setRoomHeader` outlet context is how a route replaces the header title
 * with something richer than a string — Room passes a component carrying the
 * member count and the live-connection dot. Anything else would mean the shell
 * reaching into route state.
 */
export default function AppShell() {
  const [roomHeader, setRoomHeader] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  return (
    // Every provider here sits at the shell rather than at the root for the
    // same reason: each needs a valid session, and at the root they would all
    // fire on the landing page and fail for everyone who is not signed in.
    // PresenceProvider is outermost because it reads useRealtime; the other two
    // are free to nest in either order, since neither depends on the other.
    <PresenceProvider>
      <NotificationsProvider>
        <ChatsProvider>
          <div className="grid h-dvh min-h-0 grid-cols-1 bg-canvas text-ink md:grid-cols-[240px_1fr] lg:grid-cols-[248px_1fr]">
            <aside className="hidden min-h-0 border-r border-line bg-surface md:block">
              <NavRail />
            </aside>

            {/*
             * `grid-cols-1` is required, not decorative. Specifying rows without
             * columns leaves the implicit column at `auto`, which sizes to
             * max-content — so one long decision title widened the whole shell
             * and pushed the document to 563px inside a 390px viewport, making
             * every page scroll sideways. `grid-cols-1` resolves to
             * `minmax(0, 1fr)`, which is the grid-blowout guard.
             */}
            <div className="grid min-h-0 grid-cols-1 grid-rows-[auto_1fr_auto]">
              <Navbar roomHeader={roomHeader} onMenuClick={() => setDrawerOpen(true)} />
              <main className="min-h-0 min-w-0 bg-surface">
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
                <div className="absolute left-0 top-0 h-full w-[220px] overscroll-contain border-r border-line bg-surface shadow-modal">
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
