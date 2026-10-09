import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { ChatsProvider } from '@/contexts/ChatsContext';
import Navbar from '../Navbar';
import BottomNav from './BottomNav';
import NavRail from './NavRail';
import { PresenceProvider } from '@/contexts/PresenceContext';

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
    // ChatsProvider sits here rather than at the root so the rooms request is
    // only made once the session is known to be valid. At the root it would
    // fire on the landing page too, and fail for everyone who is not signed in.
    <PresenceProvider>
      <ChatsProvider>
        <div className="grid h-dvh min-h-0 grid-cols-1 bg-canvas text-ink md:grid-cols-[240px_1fr] lg:grid-cols-[248px_1fr]">
          <aside className="hidden min-h-0 border-r border-line bg-surface md:block">
            <NavRail />
          </aside>

          <div className="grid min-h-0 grid-rows-[auto_1fr_auto]">
            <Navbar
              roomHeader={roomHeader}
              onMenuClick={() => setDrawerOpen(true)}
            />
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
    </PresenceProvider>
  );
}
