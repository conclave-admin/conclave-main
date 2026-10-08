# Conclave Frontend Redesign

Status: planning. No redesign code has been written yet, apart from the Notifications code drafted early in the session (see sections 10 and 15).

## 1. Goal

Rebuild the client so Conclave feels like an instant messaging app, not a wireframe. Decisions, Tasks and the Catch-up digest stay as the product differentiators, but they live inside the messaging experience.

Flow: Landing page, then Sign in, then the **Chats list**, then a Conversation.

## 2. Decisions made

| Topic                     | Decision                                                    |
| ------------------------- | ----------------------------------------------------------- |
| Colour palette            | Keep the current palette (indigo brand, existing tokens)    |
| Dark mode                 | Yes, add it                                                 |
| Visual inspiration        | awwwards.com, for both the landing page and the other pages |
| Landing page              | Yes, public, at `/`                                         |
| Main screen after sign in | A WhatsApp-style list of existing chats                     |
| Overall feel              | Instant messaging app                                       |
| Process                   | Plan first, then build                                      |

## 3. Current state (audit summary)

**Pending pages**

- `/notifications` and `/settings` are TODO stubs. The sidebar link labelled "Invite members" points to `/settings`.
- `/dms` has no route and falls through to Home.
- Navbar search and bell buttons do nothing and there is no unread badge.
- Profile is a placeholder. It does not edit name, bio or avatar, and Delete account uses `window.alert` although `DELETE /users/me` exists.

**Pages that look built but are not wired**

- Home, Decisions, Tasks and Digest only render fixtures when `isDevAuthBypass` is on. Otherwise they show an empty state and never call the API.
- Decisions search is uncontrolled and "New decision" does nothing.
- Tasks has no create and no status change.
- Digest crashes on an unknown item `type` (`ITEM_TYPES[type]` is undefined), which the API contract says must be handled.
- On mobile the digest and "New decision" are unreachable.

**Chat**

- The backend supports edit, delete, reactions, attachments and structured mentions. The UI has none of these. Attach and mention buttons are inert and the composer has a fixed height.
- Opening a room never calls `POST /rooms/:id/seen`.
- No avatars, only grey circles. No shared Avatar, Modal, Textarea, Select or Badge components.

## 4. Routes

| Route                                               | Screen                                              | Access      |
| --------------------------------------------------- | --------------------------------------------------- | ----------- |
| `/`                                                 | Landing page (logged-in users redirect to `/chats`) | Public      |
| `/login`, `/register`                               | Redesigned auth                                     | Public only |
| `/chats`                                            | Chat list                                           | Protected   |
| `/chats/:roomId`                                    | Conversation                                        | Protected   |
| `/chats/:roomId/info`                               | Members, files, pinned decisions, tasks             | Protected   |
| `/new`                                              | New chat, new group, find people                    | Protected   |
| `/tasks`, `/decisions`, `/digest`, `/notifications` | Secondary screens wired to the real API             | Protected   |
| `/settings`, `/profile`                             | Account and preferences                             | Protected   |

Home (the metrics dashboard) stops being the default screen. Its content moves into a "Catch up" card at the top of the chat list and into the digest.

## 5. Layout by screen size

Only two breakpoints, per the repo rule: `md` (768px) and `lg` (1280px). Below `md` is the base layout. Use fluid widths and `min-w-0` so nothing breaks between 320px and 1920px.

- **Mobile (base):** the chat list is the whole screen. Tapping a chat pushes the conversation full screen with a back arrow. A bottom tab bar shows Chats, Tasks, Decisions and Me. Notifications is a bell in the header. The composer sticks above the keyboard and uses `dvh` units.
- **Tablet (`md`):** two panes, list on the left and conversation on the right. The tab bar becomes a slim icon rail.
- **Desktop (`lg`):** rail, list, conversation, and a collapsible info panel on the right.

## 6. Messaging experience

**Chat list rows**

- Avatar with online dot, name, last message preview, time, unread badge, mute and pin indicators.
- Sticky search, filter chips (All, Unread, Groups, DMs), floating compose button on mobile.
- A "Catch up" card at the top when there are unread decisions or tasks.

**Conversation**

- Bubbles: own messages on the right in brand colour, others on the left on a soft surface. Consecutive messages are grouped and tails show only on the last one.
- Day separators, sent and pending ticks (the icons already exist), typing dots, "jump to latest" pill.
- Reply preview, edited label, deleted tombstone, reaction chips.
- Hover or long-press actions: reply, react, edit, delete, Make decision, Create task.
- Pinned decision strip under the header.
- Composer: rounded pill that grows to about 5 lines, attach with upload preview, mention picker that sends `mentionedUserIds`, Enter to send with IME safety.

**Motion and polish**

- Skeleton loaders instead of spinners, new-message slide-in, bottom sheets on mobile, modals on desktop, toasts for errors.
- Subtle chat background and a slightly larger message font (15px).

## 7. Landing page

- Sticky nav with logo, Features, and Sign in / Get started buttons. Collapses to a menu on mobile.
- Hero with the tagline "Messaging that survives the scroll" (draft) and a live-looking CSS chat mock.
- Three feature blocks (Decisions, Action items, Catch-up digest), a "how it works" strip, a final call to action, and a footer.
- Fully responsive.

## 8. Backend support needed

Existing facts: `GET /rooms` returns `slug, type, member_count, my_role, last_seen_at`. Typing events already exist over the socket (`typing`, `stop-typing`, `room-typing`). `message-read` is broadcast but not persisted. Each user already has a personal socket channel (`personalRoom(userId)`). Sockets only join a room channel on `join-room`.

Status of the changes this redesign needs:

- **Done (phase 1).** `GET /rooms` now returns `display_name` / `display_avatar` (for a DM, the other member's identity rather than the room title), `has_message`, `last_message` (`{ id, content, sender_id, sender_name, sender_avatar, has_attachment, is_deleted, created_at }`, or `null` for a room nobody has spoken in) and `unread_count`, ordered by last activity. `unread_count` excludes your own messages and tombstones.
- **Done (phase 1).** `chat:updated { roomId, lastMessage, unreadCount }` goes to **each member's personal channel**, never the chat room, because `unreadCount` is one person's number. Fires after every message create, edit and delete.
- **Verified, no backend change.** Find-or-create DM already works: `POST /rooms { name, memberIds: [userId] }` returns the existing 2-member DM rather than minting a second one. It only requires a `name`, which the client can take from `GET /users` results. (`POST /rooms/dm` is Victor's Item F and was deliberately left alone.)
- All new responses go through the existing `apiResponse` util and `ApiError`.
- Read receipts: persistence is deferred. v1 ships "sent" ticks only.
- Search: room search first. Global message search later, restricted to the caller's rooms.

## 9. Confirmed defaults

Confirmed for this build. Recorded rather than re-asked; override by editing here.

**Awwwards scope.** Two tiers. The landing page is fully expressive (huge editorial headings, scroll-driven reveals, marquee, grid lines, animated chat mock, page transitions). App screens use the same craft but restrained, with tight hierarchy, generous spacing and refined micro-interactions, and nothing that slows typing or scrolling. Respect `prefers-reduced-motion` everywhere.

**Libraries and fonts**

- GSAP with ScrollTrigger on the landing page only, lazy-loaded. CSS transitions inside the app.
- No smooth-scroll library in the app. Optional on the landing page only.
- One display typeface for landing headings, paired with Inter Tight in the app.

**Dark mode mechanics**

- Convert colour tokens to CSS variables (channel format, so `bg-brand/20` keeps working) and use `darkMode: 'class'`.
- Follow the system setting, with a manual Light, Dark, System switch in Settings, saved in localStorage.
- Tiny inline script in `index.html` to avoid a flash of the wrong theme.
- Same indigo brand, tuned for contrast on dark surfaces, with a dark value for every token.
- This changes `tailwind.config.js` and `index.css`.

**Scope cut list.** Exclude calls, video, voice notes, stories and disappearing messages (icons exist but there is no backend). Pin chat and mute have no backend, so skip them or keep them local to the browser. Video uploads are not accepted by the API yet.

**Technical choices**

- Stay on JavaScript, no TypeScript migration.
- No data-fetching library. Add `ChatsProvider` and `NotificationsProvider` fed by sockets.
- Keep `node --test`, with unit tests for new hooks and helpers.
- Lazy-load routes, keep the first chat-list render light, virtualise long message lists later if needed.

## 10. Notifications code already drafted

The following were drafted early in the session and remain valid to adapt into the new shell. The code and its initial implementation notes are recorded in section 15:

- `components/ui/Avatar.jsx`
- `services/notifications.service.js`
- `hooks/useNotifications.js`
- `pages/Notifications.jsx`
- Navbar bell as a link to `/notifications`

Planned follow-up: lift `useNotifications` into a `NotificationsProvider` so the badge and the page share one state, and handle `notification:seen` for multi-tab sync.

## 11. Build phases

1. **Backend (DONE):** enrich `GET /rooms`, add `chat:updated`, verify DM find-or-create. No backend change was needed for find-or-create — see section 8. Anything beyond this phase needs asking again before `backend/` is touched.
2. **Foundations:** refreshed tokens, dark mode, shared components (Avatar with presence, Badge, Modal and bottom sheet, Tabs, Skeleton, Toast).
3. **Landing page and auth redesign.**
4. **Chats shell:** routing, chat list, responsive panes, bottom nav and rail.
5. **Conversation upgrade:** bubbles, actions, reactions, edit and delete, uploads, mentions, room-seen call.
6. **Decisions, Tasks, Digest, Notifications:** real API, create and status actions, integrated into chat.
7. **Settings, Profile edit, New chat, member management.**
8. **QA** at 360, 390, 768, 1024, 1280 and 1440 widths, plus accessibility.

Delivery style: code written in chat, one file at a time, grouped by phase. No files built apart from `.md` documents.

## 12. Working rules from the repo (docs/CLAUDE.md)

- Only `md` and `lg` breakpoints. No `sm`.
- Use Tailwind tokens, never hardcoded hex or arbitrary px (dark mode will move tokens to CSS variables).
- Line heights are unitless 1.2.
- Icons only from `client/src/assets/icons/`, imported with svgr. If one is missing, stop and ask.
- Do not change backend API contracts or service-layer signatures without agreement.
- The Penpot boards are the current design source. This redesign deliberately moves beyond them, so `docs/CLAUDE.md` and the token comments need updating when it lands.

## 13. Pending questions

1. ~~**Defaults:** do you accept the proposed defaults in section 9, or which ones do you want to change?~~ **Answered: yes, section 9 is confirmed.**
2. **Display font:** do you want to choose the landing page display typeface, or should I propose two or three candidates?
3. ~~**Team coordination:** should the frontend owner and the room endpoint owner be looped in before work starts? Proposed: a dedicated branch (for example `redesign/messaging-ui`) and a heads-up before touching `rooms.controller.js`.~~ **Answered: work on `branch-michael`; backend work is announced and confirmed first.** `rooms.controller.js` was touched for phase 1 with that confirmation.
4. **Landing content:**
   - Tagline and tone (draft: "Messaging that survives the scroll").
   - Logo, or is the "CONCLAVE" wordmark enough?
   - Include pricing, Privacy and Terms pages, or only footer placeholders?
5. **Read receipts:** confirm that v1 ships "sent" ticks only, with persisted read receipts deferred.
6. **Search scope:** confirm room search first, global search later.

Questions 2, 4, 5 and 6 are parked until the phase that needs them (3, 3, 5 and 4 respectively).

## 14. Next step

Phase 1 is complete. Phase 2 — foundations: colour tokens as CSS variables, `darkMode: 'class'`, the anti-FOUC script, and the shared components (Avatar, Badge, Textarea, Select, Skeleton, Modal, Sheet, Tabs, Toast).

Working rule for this build: **no visual tests until Michael gives confirmation.** Verification is `npm test` and `npm run build` only.

## 15. Early-session audit and Notifications draft

The initial client, docs and backend review is summarized in section 3. The initial implementation order was shared UI (Avatar, Modal, Textarea, Badge and PageHeader), Notifications with shared state, wiring Decisions, Tasks and Digest to the API, Settings and Profile editing, direct messages, chat upgrades, and Home from real data. The build phases in section 11 are the current plan.

The initial implementation followed docs/CLAUDE.md: only md and lg breakpoints, tokens instead of hex, icons only from the existing folder, and no backend contract changes. Anything new on the backend would use the existing response utilities.

### Step 1: Avatar and Notifications

client/src/components/ui/Avatar.jsx

```
jsx
const SIZES = {
  sm: 'h-8 w-8 text-metadata',
  md: 'h-10 w-10 text-label',
  lg: 'h-16 w-16 text-h2',
};

export function initialsOf(name = '') {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

export default function Avatar({ name, src, size = 'md', className = '' }) {
  const box = `${SIZES[size]} shrink-0 rounded-full ${className}`;
  if (src) return <img src={src} alt="" className={`${box} object-cover`} />;
  return (
    <span className={`${box} grid place-items-center bg-brand-soft text-brand`} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
```

client/src/services/notifications.service.js

```
js
import { api } from '../lib/api';
import { isDevAuthBypass } from '../config/devPreview';

const previewPage = {
  notifications: [
    {
      id: 'n1',
      type: 'mention',
      seen: false,
      created_at: new Date(Date.now() - 12 * 60000).toISOString(),
      context: { room_id: 'preview-room', room_name: 'Product & Engineering', actor_name: 'Victor', message_preview: 'Can you confirm the upload limits before Friday?' },
    },
    {
      id: 'n2',
      type: 'room_invite',
      seen: true,
      created_at: new Date(Date.now() - 5 * 3600000).toISOString(),
      context: { room_id: 'preview-room', room_name: 'Launch Planning', actor_name: 'Priya', message_preview: null },
    },
  ],
  unreadCount: 1,
  nextCursor: null,
};

export async function listNotifications({ before, unseenOnly } = {}) {
  if (isDevAuthBypass) return previewPage;
  const params = {};
  if (before) params.before = before;
  if (unseenOnly) params.unseenOnly = true;
  const { data } = await api.get('/notifications', { params });
  return data.data;
}

export async function markSeen(body) {
  if (isDevAuthBypass) return { updated: 0 };
  const { data } = await api.patch('/notifications/seen', body);
  return data.data;
}
```

client/src/hooks/useNotifications.js

```
js
import { useCallback, useEffect, useState } from 'react';
import { useRealtime } from '../contexts/RealtimeContext';
import { listNotifications, markSeen } from '../services/notifications.service';

export default function useNotifications({ unseenOnly = false } = {}) {
  const { socket } = useRealtime();
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const page = await listNotifications({ unseenOnly });
      setItems(page.notifications);
      setUnreadCount(page.unreadCount);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load notifications.');
    } finally {
      setIsLoading(false);
    }
  }, [unseenOnly]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!socket) return undefined;
    // The payload is always a complete row, never a count.
    const receive = ({ notification }) => {
      setItems((current) =>
        current.some((item) => item.id === notification.id) ? current : [notification, ...current],
      );
      if (!notification.seen) setUnreadCount((count) => count + 1);
    };
    socket.on('notification', receive);
    return () => socket.off('notification', receive);
  }, [socket]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await listNotifications({ before: cursor, unseenOnly });
      setItems((current) => [...current, ...page.notifications]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load more.');
    } finally {
      setIsLoadingMore(false);
    }
  }, [cursor, isLoadingMore, unseenOnly]);

  const markOne = useCallback(
    async (id) => {
      const target = items.find((item) => item.id === id);
      if (!target || target.seen) return;
      setItems((current) => current.map((item) => (item.id === id ? { ...item, seen: true } : item)));
      setUnreadCount((count) => Math.max(0, count - 1));
      try {
        await markSeen({ notificationId: id });
      } catch {
        setItems((current) => current.map((item) => (item.id === id ? { ...item, seen: false } : item)));
        setUnreadCount((count) => count + 1);
      }
    },
    [items],
  );

  const markAll = useCallback(async () => {
    setItems((current) => current.map((item) => ({ ...item, seen: true })));
    setUnreadCount(0);
    try {
      await markSeen({ all: true });
    } catch {
      load();
    }
  }, [load]);

  return { items, unreadCount, hasMore: Boolean(cursor), isLoading, isLoadingMore, error, loadMore, markOne, markAll };
}
```

client/src/pages/Notifications.jsx

jsx

```
import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import Avatar from '../components/ui/Avatar';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import Spinner from '../components/ui/Spinner';
import useNotifications from '../hooks/useNotifications';

function describe(notification) {
  const actor = notification.context?.actor_name || 'Someone';
  const room = notification.context?.room_name || 'a room that no longer exists';
  const preview = notification.context?.message_preview ?? null;
  switch (notification.type) {
    case 'mention':
      return { title: `${actor} mentioned you in ${room}`, body: preview ?? 'This message was deleted.' };
    case 'room_invite':
      return { title: `${actor} added you to ${room}`, body: null };
    default:
      // Unknown types must never throw, the backend may add more.
      return { title: `New activity in ${room}`, body: preview };
  }
}

function timeAgo(iso) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Row({ item, onOpen }) {
  const { title, body } = describe(item);
  const roomId = item.context?.room_id;
  const className = `flex min-h-14 w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors md:gap-4 md:px-5 ${
    item.seen ? 'border-line bg-surface hover:bg-canvas' : 'border-brand/20 bg-brand-soft hover:bg-brand-soft/70'
  }`;
  const content = (
    <>
      <Avatar name={item.context?.actor_name} size="md" />
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink [overflow-wrap:anywhere]">{title}</p>
        {body && <p className="mt-1 line-clamp-2 text-metadata text-muted [overflow-wrap:anywhere]">{body}</p>}
        <p className="mt-2 text-metadata text-muted">{timeAgo(item.created_at)}</p>
      </div>
      {!item.seen && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
    </>
  );
  if (!roomId) {
    return (
      <button type="button" onClick={() => onOpen(item)} className={className}>
        {content}
      </button>
    );
  }
  return (
    <Link to={`/rooms/${roomId}`} onClick={() => onOpen(item)} className={className}>
      {content}
    </Link>
  );
}

export default function Notifications() {
  const { setRoomHeader } = useOutletContext();
  const [filter, setFilter] = useState('all');
  const { items, unreadCount, hasMore, isLoading, isLoadingMore, error, loadMore, markOne, markAll } =
    useNotifications({ unseenOnly: filter === 'unread' });

  useEffect(() => {
    setRoomHeader('Notifications');
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  const tab = (value, label) => (
    <button
      type="button"
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
      className={`min-h-10 rounded-lg px-4 text-label transition-colors ${
        filter === value ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-canvas hover:text-ink'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pb-8 pt-6 md:pt-9">
      <div className="mx-auto max-w-[720px]">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex gap-2">
            {tab('all', 'All')}
            {tab('unread', `Unread${unreadCount ? ` · ${unreadCount}` : ''}`)}
          </div>
          <Button variant="secondary" onClick={markAll} disabled={!unreadCount} className="w-full md:w-auto">
            Mark all as read
          </Button>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          {isLoading && <Spinner label="Loading notifications" />}
          {error && <p className="rounded-lg bg-error/10 p-4 text-body text-error">{error}</p>}
          {!isLoading && !error && items.length === 0 && (
            <div className="rounded-xl border border-dashed border-line">
              <EmptyState
                title={filter === 'unread' ? 'You are all caught up' : 'No notifications yet'}
                description="Mentions and room invitations will show up here."
              />
            </div>
          )}
          {!isLoading && items.map((item) => <Row key={item.id} item={item} onOpen={(n) => markOne(n.id)} />)}
          {hasMore && !isLoading && (
            <Button variant="secondary" onClick={loadMore} disabled={isLoadingMore} className="self-center">
              {isLoadingMore ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
```

Navbar bell becomes a real link. In Navbar.jsx, add import { Link } from 'react-router-dom'; and replace the notifications button with:

jsx

```
<Link to="/notifications" aria-label="Notifications" className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-canvas">
  <IconNotify className="h-6 w-6 text-ink" />
</Link>
```

### Draft notes

The unread badge on the bell needs the notification state shared with the page. Next I'd lift useNotifications into a small NotificationsProvider so the Navbar and the sidebar read the same count instead of fetching twice.
I did not handle the notification:seen socket event, so a second tab won't clear its badge until it reloads. The provider fixes this.
Opening an unread row marks it seen and navigates to the room.

### Question before step 2

Notifications, Settings and DMs have no Penpot board, as DESIGN_QUESTIONS B1 and B2 already note. Propose the layouts yourself using the existing tokens
