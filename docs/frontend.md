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

- `/settings` and `/profile` exist; Profile is still a placeholder that does not edit name, bio or avatar, and Delete account uses `window.alert` although `DELETE /users/me` exists.
- `/new` and `/chats/:roomId/info` are honest stubs with an empty state, behind a working route and a working link.
- `/rooms/:roomId` no longer exists. It was replaced by `/chats/:roomId` in phase 4; the old path is not redirected because nothing external linked to it and a permanent redirect for a dead URL is a lie about a feature that no longer has that shape.

**Resolved in phase 4**

- The sidebar linked to `/dms`, which had no route and fell through to the catch-all. It now resolves to `/chats?filter=dms`.
- The sidebar item labelled "Invite members" pointed at `/settings`. It now points at `/new`, and Settings has its own item.
- `/digest` had no entry point anywhere in the UI. It is a rail item now, and the chat list has a Catch-up card linking to it.
- Navbar search and bell were inert buttons. Search writes `?q=` onto `/chats`; the bell links to `/notifications`. Both carry a real unread count.
- Opening a room never marked it read. `Room` now calls `POST /rooms/:roomId/seen` on open, optimistically zeroing the badge first.
- `chat:updated` was emitted by the server and ignored by the client. `ChatsContext` consumes it.
- Pin and mute exist as row actions, stored per browser in `localStorage`. There is no backend for either — see section 6.

**Pages that look built but are not wired**

- Home, Decisions, Tasks and Digest only render fixtures when `isDevAuthBypass` is on. Otherwise they show an empty state and never call the API.
- Decisions search is uncontrolled and "New decision" does nothing.
- Tasks has no create and no status change.
- Digest crashes on an unknown item `type` (`ITEM_TYPES[type]` is undefined), which the API contract says must be handled.
- On mobile the digest and "New decision" are unreachable.

**Chat**

- The backend supports edit, delete, reactions, attachments and structured mentions. The UI has none of these. Attach and mention buttons are inert and the composer has a fixed height.
- Opening a room calls `POST /rooms/:roomId/seen`. Worth stating plainly because it was wrong for a while: phase 4 shipped this as `api.patch`, but the route is registered as POST (`rooms.routes.js`), so every call 404'd and the badge cleared only from the optimistic update. Fixed in phase 5.
- Avatars, Modal, Textarea, Select and Badge are shared components from phase 2. Presence dots are not drawn: the client does not subscribe to room presence, so a green dot would be invented.

## 4. Routes

| Route                                               | Screen                                              | Access      |
| --------------------------------------------------- | --------------------------------------------------- | ----------- |
| `/`                                                 | Landing page (logged-in users redirect to `/chats`) | Public      |
| `/login`, `/register`                               | Redesigned auth                                     | Public only |
| `/chats`                                            | Chat list                                           | Protected   |
| `/chats?filter=unread\|groups\|dms`, `?q=`          | Same list, filtered and searched                    | Protected   |
| `/chats/:roomId`                                    | Conversation                                        | Protected   |
| `/chats/:roomId/info`                               | Members, files, pinned decisions, tasks (stub)      | Protected   |
| `/dms`                                              | Redirect to `/chats?filter=dms`                     | Protected   |
| `/new`                                              | New chat, new group, find people (stub)             | Protected   |
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

- Avatar, name, last message preview, time, unread badge, mute and pin indicators. No presence dot — see the known gaps in section 14.
- Sticky search, filter chips (All, Unread, Groups, DMs).
- A "Catch up" card at the top when there are unread decisions or tasks, reading the same `GET /digest` payload as the digest page.
- **No floating compose button on mobile yet.** `/new` is reachable from the drawer's "Invite members" item, which is one tap fewer than a FAB but not the affordance this section describes. It is deferred rather than skipped silently.
- Pin and mute are per-browser only. The row menu says so in place.

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
4. **Chats shell (DONE):** routing, chat list, responsive panes, bottom nav and rail. Also took the room-seen call out of phase 5, because the unread badge cannot be judged without it.
5. **Conversation upgrade (DONE):** bubbles, grouping, ticks, typing, actions, reactions, edit and delete, uploads, mentions, pinned decision strip. Backend work was confirmed and included: migration 014, `decisionPin.service.js`, pin routes, and `message-read` now persisting `last_seen_at` instead of being memory-only.
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
2. ~~**Display font:** do you want to choose the landing page display typeface, or should I propose two or three candidates?~~ **Answered: Instrument Serif**, loaded from Google Fonts, used for landing headings only and paired with Inter Tight everywhere else.
3. ~~**Team coordination:** should the frontend owner and the room endpoint owner be looped in before work starts? Proposed: a dedicated branch (for example `redesign/messaging-ui`) and a heads-up before touching `rooms.controller.js`.~~ **Answered: work on `branch-michael`; backend work is announced and confirmed first.** `rooms.controller.js` was touched for phase 1 with that confirmation.
4. **Landing content:** ~~all three answered.~~
   - ~~Tagline and tone (draft: "Messaging that survives the scroll").~~ **Answered: keep the draft tagline.**
   - ~~Logo, or is the "CONCLAVE" wordmark enough?~~ **Answered: a logo file will be supplied later; render a placeholder slot in the nav until it arrives.** No logo asset exists in `client/src/assets/` today — only the icon sprite.
   - ~~Include pricing, Privacy and Terms pages, or only footer placeholders?~~ **Answered: footer placeholders only.** They render an empty shell rather than a written page; pricing especially needs copy that does not exist.
5. ~~**Read receipts:** confirm that v1 ships "sent" ticks only, with persisted read receipts deferred.~~ **Answered in phase 5: shipped, and made persistent.** `message-read` now writes `room_members.last_seen_at` rather than only emitting, so the tick survives a reload. It means "at least one other member has caught up", not everyone.
6. **Search scope:** confirm room search first, global search later. Still open — room-level message search is built server-side but not yet used by any client surface.

Questions 5 and 6 are parked until the phases that need them (5 and 4 respectively). Questions 2 and 4 were needed for phase 3 and are now answered above.

## 14. Next step

Phases 1 to 5 are complete (commits `0d91968`, `bed546b`, `e92f530`; phases 4 and 5 are built and verified but not yet committed). **Phase 6 — Decisions, Tasks, Digest, Notifications.**

Phase 5 left the following, and phase 6 should not re-litigate them:

- Sending goes over the socket (`send-message`), never `POST /messages`. Both write through the same service, but only the socket handler emits `receive-message`, so a REST send leaves every other member's open conversation stale. This is not an optimisation choice.
- `message-read` now persists `room_members.last_seen_at` and emits to the whole room. The read tick is derived by comparing that pointer to the message timestamp — a room-level fact, not a stored per-message one, which is why it survives a reload.
- Read ticks mean "at least one other member has caught up", not everyone. In a room of forty, waiting for unanimous catch-up means a tick that almost never appears.
- Mentions send `mentionedUserIds` (ids, not names). Display names are not unique; the name-only inference path is documented as temporary and wrong.
- Attachments upload on pick, not on send. A 25MB failure discovered after the message is composed loses the message with the file.
- Reaction allowlist is `👍 👎 🎉 ✅` — no heart, because ❤️ has two encodings and Postgres treats them as different strings.
- `isComposing` (and the `keyCode === 229` fallback) must gate Enter. Enter commits an IME character; sending on it eats the character just chosen.
- The pinned strip drives off the `pins` object the server attaches to every decision and off `decision:pinned` / `decision:unpinned`, both of which carry a whole decision — a replace, not a filter.
- `decorateMessages` in `lib/messageMeta.js` is the single source of grouping, day labels and read status. Do not re-derive them in a component.

**Known gaps this phase does not close.** These are open, not oversights:

- **No per-decision detail route.** `PinnedDecisionStrip` links to `/decisions` because nothing resolves a single decision. Adding `GET /decisions/:id` and a route is the honest fix; inventing a URL that 404s to the landing page is not.
- **The Decisions page is still a placeholder.** It renders `previewDecisions` or an empty state and never calls `listRoomDecisions`, so the strip is currently the only real consumer of decisions data.
- **No chat-list presence dots.** `room-presence` on join is a complete roster but `user-online` / `user-offline` are deltas with no initial roster, so a global presence map cannot be built without lying. `PresenceContext` is deliberately room-scoped and only draws dots in the open conversation.
- **Reply targets degrade when unloaded.** There is no `GET /messages/:id`, so a reply to a message outside the loaded window renders "an earlier message" rather than fetching.
- **The navbar unread badge is the room unread total, not a notifications count.** `GET /notifications` returns a paged feed with no unread aggregate, so any other number would be invented.
- **Room-level message search (`GET /messages/room/:roomId/search`) is unused.** The header search matches room names only, because that endpoint cannot search across rooms.

**Bundle-size finding (DECIDED: leave alone).** Each file in `client/src/assets/icons/` is ~8 kB, of which ~97% is an embedded `<metadata>` C2PA provenance manifest; only ~270 bytes is the actual path. svgr carries that manifest into the bundle as a JSX string, so every distinct icon imported costs ~8 kB. Phases 4 and 5 went from 28 to 43 distinct icons, and the main chunk grew from 484 kB to 637 kB — roughly 116 kB of that is manifest text. Stripping `<metadata>` from the 90 icons would have cut the icon payload by ~92% (~665 kB of source), but it was considered and **explicitly declined** — the manifests stay. The practical consequence for later phases: every new icon import is a ~8 kB cost, so reuse existing glyphs rather than adding near-duplicates, and treat the chunk warning as expected rather than as a regression.

Working rule for this build: **no visual tests until Michael gives confirmation.** Verification is `npm test` and `npm run build` only. Phases 4 and 5 are almost entirely layout and are therefore the phases most likely to be wrong in ways those two commands cannot see.

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

## 16. Assets to be supplied

The icon sprite at `client/src/assets/icons/` covers almost everything the redesign calls for. The four below do not, and the repo rule is to stop and ask rather than draw a substitute, so they are listed here for Michael to supply.

| File             | Needed for                                                         | Until it exists                                         |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `sun.svg`        | Light theme indicator                                              | The switch uses the text label "Light" instead          |
| `moon.svg`       | Dark theme indicator                                               | The switch uses the text label "Dark" instead           |
| `edit.svg`       | Message edit action — section 6 lists "reply, react, edit, delete" | Edit has no icon and cannot be placed in the action row |
| `arrow-down.svg` | The "jump to latest" pill in the conversation — section 6          | The pill has no glyph and cannot be built               |

These are icon-sprite entries: same folder, imported with svgr, drawn to match the existing set.

**Separately, the logo.** Not a sprite entry. A brand asset for the slot currently drawn as an empty dashed box in `components/landing/Logo.jsx`, which appears in the landing nav, the auth screens and the footer. When it arrives it replaces that slot directly; nothing else in the component changes. There is no `og:image` on the landing either, for the same reason — pointing a share card at a missing image renders worse than shipping a text-only one, so that gets added at the same time.

Everything else the remaining phases need already exists in the sprite: `sent` and `pending` ticks, `reaction`, `pin`, `attach`, `mention`, `reply`, `decisions`, `tasks`, `notify`, `compose`, `menu`, `close`, `chevron-*` and the rest.
