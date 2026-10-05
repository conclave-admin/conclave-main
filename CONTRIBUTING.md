# Contributing to Conclave

## Who works on what

Three people, three lanes. The split is by **layer**, not by feature, because the
frontend and backend are contractually bound to each other — features that span
both need a pairing, and features inside one lane can be picked up and finished
without waiting on anyone.

| Owner   | Lane      | Owns                                                                 |
| ------- | --------- | -------------------------------------------------------------------- |
| Michael | Backend   | Auth, users, rooms, and the shared write path in `services/`           |
| Victor  | Backend   | The differentiator layer: decisions, tasks, digest, sockets, upload    |
| Isaac   | Frontend  | Everything under `client/`, including design fidelity and the fixtures |

---

## Michael — Backend, foundations

**Why this lane:** auth and rooms are the substrate everything else queries
against. Room membership is checked by nearly every other controller, so these
need to be right and stable first.

**Current state: complete.** Auth (register/login/refresh/logout with rotation),
users (me/update/list/delete), rooms (create/list/get/add member/mark seen) are
all implemented and hardened.

**Owns going forward:**

- **Item G — Group access.** Victor has chosen open registration for everyone.
  Invitations belong to private group collaboration, with public/private group
  preferences controlled by users/admins. Implement group discovery/joining and
  invitation permissions without gating account registration. Anonymous group
  reads are not yet specified; existing room reads remain membership-restricted.
- **Item F — Rooms management.** Update room name, leave room, remove member,
  delete room, promote member to admin. Also `POST /rooms/dm { userId }` to find
  or create a DM, which the `/dms` screen needs — `createRoom` dedupes but
  there's still no way to *find* one.
- **Item D — Home page data.** `GET /home/summary`, or `unread_count` on
  `listRooms`. Now unblocked because `last_seen_at` actually moves.
- **Rate limiting on `/auth/*`.** Needs a dependency choice
  (`express-rate-limit` vs hand-rolled on Redis) — raise it, don't just pick.
- **`role_id` is never checked anywhere.** Decide what it's for or drop it.
- **`listUsers` leaks every user's email to any authenticated caller.** Scope it
  to shared rooms, or hide the address. Product/privacy call.

**Watch out for:**

- `requireAuth` now runs one `SELECT 1 FROM users ... AND deleted_at IS NULL` per
  authenticated request. That's deliberate — a JWT can't be revoked, so this is
  what makes account deletion mean anything — but it is a hot path. Don't remove
  it; if it ever needs to be cheaper, cache it with a short TTL.
- Anything that changes `room_members` or `users` affects the digest window
  (`last_seen_at`) and every membership check in the codebase.

---

## Victor — Backend, the differentiator layer

**Why this lane:** decisions, tasks and digest are what separates Conclave from a
chat clone, and they are the least built. This is the highest-leverage work.

**Current state: mixed.** Decisions, digest and task APIs are implemented.
Notifications and upload remain 501 stubs.

**Owns going forward, in priority order:**

1. **Item C — File upload.** Unblocks the composer's attach button, and is the
   prerequisite for closing a real security hole: `message.service.js` currently
   takes the attachment `url` straight from the request body, so any room member
   can persist an arbitrary string as a file URL. Once uploads exist, look the
   URL up from the upload record instead. Stream to `cloudinary.uploader.upload_stream`,
   allowlist mime types, return `{ filename, url, mime_type, size }`.
2. **Item A — Tasks integration.** Create/list/status APIs, membership checks,
   pagination and socket events are implemented and database-tested. Pair with
   Isaac on the board; assignment notifications remain part of item B.
3. **Item B — Notifications.** `GET /notifications` with an unread count, and
   `PATCH /notifications/seen`. The table stores only `type` and `reference_id`,
   so the list needs a join to return readable text. Create `new_message` and
   `mention` rows and emit `notification` — `addMember` already writes a
   `room_invite` row and never emits it, which is the natural place to close that.
4. **Item H — Structured mentions.** The regex mention matcher is correct but
   it is still text matching, and a display name is not an identity: renaming a
   user changes who gets mentioned. Add `message_mentions(message_id, user_id)`,
   parse from a client-supplied `mentionedUserIds`, and use it for the digest and
   notifications.
5. **Item I — Message edit, delete, reactions.** `edited_at` and `deleted_at` ship
   in every payload and `message_reactions` has a table but no routes. The read
   side already handles soft-deleted rows (content withheld, `is_deleted` set), so
   once the delete endpoint exists it will behave.
6. **Global search (Item E)** — or decide the navbar icon opens per-room search only.

**Watch out for:**

- `decisions.searchDecisions` must keep its `to_tsvector` expression byte-identical
  to the one in `007_decisions_search_includes_tags.sql`, or the GIN index stops
  being used and search silently gets slow. Tags are matched separately because
  `array_to_string` is STABLE, not IMMUTABLE, so it can't be folded into an index.
- Socket events are documented at the top of `sockets/index.js`. Add to that list
  when you add an event — the previous list advertised four events that were never
  emitted.
- Emit errors on `error:message`, not `error`. Socket.IO reserves `error`.

---

## Isaac — Frontend

**Why this lane:** the UI is built to a finished Penpot design and is largely
reviewable, but most of it is currently reading fixtures rather than endpoints.

**Current state: polished but disconnected.** Every protected route renders, but
seven of nine read from `config/devPreview.js`. The backend has shipped four
endpoints the client never calls.

**Highest-leverage first — these are backend fixes the client never picked up:**

- **Delete account works now.** `Profile.jsx` still calls `window.alert` and its
  comment claims no endpoint exists. `DELETE /api/users/me` was repaired by
  migration 006 and is live. Wire it up.
- **Call `POST /rooms/:roomId/seen` when a room is opened.** Until you do,
  `room_members.last_seen_at` only advances on socket `leave-room`, and
  `GET /api/digest` keeps reporting everything since the user joined. The entire
  digest feature is inert without this one call.
- **Session refresh and socket reconnect credentials are now wired.** Follow up
  on coordination across browser tabs and complete a live expiry/reconnect check.

**Then the feature work:**

- **Create the missing services.** `decisions.service.js`, `tasks.service.js`,
  `digest.service.js` and `notifications.service.js` do not exist. The backend
  endpoints for decisions, tasks and digest are implemented.
- **`CatchUpDigestPage.jsx` will crash on an unknown item type.**
  `ITEM_TYPES[type]` destructures with no default — one unexpected `type` from
  the backend throws and takes the page down.
- **Pagination.** `useMessages` receives `nextCursor` and discards it. There's no
  "load older" and the `before` parameter is never passed.
- **Dead affordances to either wire or remove:** the Decisions search input (no
  state, no filtering), "New decision", the composer's Attach and Mention
  buttons, the navbar Search and Notifications buttons, and the hardcoded green
  "Available" dot in the sidebar footer (there is no presence subscription, so it
  is fiction in every environment).
- **Bypass `logout` is a no-op.** `AuthContext.jsx` sets `previewUser` instead of
  `null` under `VITE_DEV_AUTH_BYPASS`, so the Profile logout button does nothing
  in preview mode.
- **`Room.jsx` remounts the header on every reconnect** because the header effect
  depends on `isConnected`.
- **`Profile.jsx` never calls `setRoomHeader`**, so its navbar reads "Workspace
  overview" while Decisions/Tasks/Digest correctly set their own.
- **`Settings` and `Notifications` are 9-line TODO stubs**, and both use
  `text-gray-500` — a stock Tailwind colour, not a Foundations token (`muted`).
  Their backend endpoints are 501, so be honest about that in the UI rather than
  calling them and rendering a placeholder as data.

**Constraints — read `docs/CLAUDE.md` before touching any component.** It is
binding, not advisory:

- Design values come from the connected Penpot file. There is no local spec file.
- Use Tailwind tokens. Never hardcode a hex or an arbitrary px. Board-measured
  values belong at `lg:` (Desktop, 1280) or `md:` (Tablet, 768).
- **`sm` is removed on purpose.** `md` and `lg` are the only breakpoints.
- Line heights are unitless 1.2.
- Some things deliberately have no board and no breakpoint value: RoomHeader's
  dynamic text, Room's error states, MessageTimeline's bottom padding. Don't
  invent one.
- Icons: check `client/src/assets/icons/` first, import via `?react`, never write
  inline SVG, never add an icon library. If the icon genuinely doesn't exist,
  stop and ask. 16 of the 90 icons are currently in use.

---

## Shared working agreement

These are already in `docs/CLAUDE.md` and `docs/BACKEND_TASKS.md`. Restated here
because they are the rules that keep three people from colliding:

- **Branch and open a PR. Never push to `main`.**
- **Don't change `useMessages` or `useRoom` signatures without telling everyone.**
  The frontend is built against them. If a signature needs to change, that's a
  conversation first.
- **Never edit `client/` from a backend task, or `backend/` from a frontend task,
  without saying so first.** Cross-lane work is allowed, just announced.
- Use `ok()` and `fail()` from `utils/apiResponse.js` for every response. Don't
  hand-build response JSON.
- New tables and columns ship as a **new numbered migration** in
  `backend/database/migrations/`. Never edit an earlier one.
- **Don't batch formatting changes with functional ones.** An editor reformatted
  two whole files on a recent commit, turning a 4-line fix into a 172-line diff.
  There is no Prettier config in the repo, and quote style is currently split:
  most of the backend uses single quotes, but `messages.controller.js` and
  `rooms.controller.js` use double. Pick one and enforce it in a separate commit
  that changes nothing else.
- **Commit one coherent change at a time.** Include its tests and API contract
  updates together. Keep docs cleanup, dependency upgrades and unrelated fixes
  in separate commits. Run relevant checks before committing and report the
  commit hash/message. File count alone does not define a useful commit boundary.

## Verifying your work

```bash
cd backend
npm test          # smoke and regression tests; no external services required
node --check src/**/*.js
```

The default suite covers routing, auth, errors, sockets and input validation
without external services. Run `npm run test:integration` with
`TEST_DATABASE_URL` pointing at a migrated disposable PostgreSQL database for
task permissions, queries and digest integration. CI runs both suites.

Fresh migrations and task flows have passed locally against real PostgreSQL.
Auth/room/message end-to-end flows, Redis-backed live delivery and provider
connectivity still need verification before inviting users.
