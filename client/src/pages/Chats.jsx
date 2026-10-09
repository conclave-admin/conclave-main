import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import ChatList from '@/components/chats/ChatList';
import EmptyState from '@/components/ui/EmptyState';

/**
 * The chat shell: a list on the left, the open conversation on the right.
 *
 * At `md` and up this is the two-pane layout from section 6. Below it the list
 * is the whole screen and opening a room replaces it — a 320px pane beside a
 * conversation on a phone is two unusable columns rather than one usable one.
 * The pane is therefore toggled with visibility, not rendered a second time:
 * two `<Outlet />`s for the same route would mount the room twice, and twice
 * means two timelines, two composers and two socket subscriptions.
 *
 * Both panes are driven by the URL: `/chats` is the list with nothing chosen,
 * `/chats/:roomId` is the list with a room open. Keeping the list mounted
 * while a room is open is the point — switching conversations must not
 * re-fetch and re-scroll the list, and a deep link into a room must still show
 * which room it is among the others.
 *
 * AppShell's outlet context is forwarded. A bare `<Outlet />` passes
 * `undefined` downward rather than the parent's value, so without this the
 * room pane's `useOutletContext` would find no `setRoomHeader` and the header
 * would fall back to a static title.
 */
export default function Chats() {
  const { roomId } = useParams();
  const shellContext = useOutletContext();

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[minmax(280px,320px)_1fr] lg:grid-cols-[minmax(320px,380px)_1fr]">
      <section
        className={`min-h-0 border-r border-line bg-surface ${roomId ? 'hidden md:block' : ''}`}
      >
        <ChatList />
      </section>

      <section className="min-h-0 min-w-0 bg-surface">
        {roomId ? (
          <Outlet context={shellContext} />
        ) : (
          <div className="hidden h-full items-center justify-center md:flex">
            <EmptyState
              title="Pick a chat"
              description="Choose a conversation from the list to open it here."
            />
          </div>
        )}
      </section>
    </div>
  );
}
