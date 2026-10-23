# Rooms, conversation information, and personal history

Phase 6 (GH-07–GH-16) builds on the existing voice-note, receipt, synchronization,
and encrypted-media implementation. Apply migration
`038_room_lifecycle_and_personal_history.sql` before deploying this API/client.
Run `cd backend && npm run migrate`; the migration ledger makes reruns safe.
There are no new environment variables or packages.

## Conversation information

DM and room information include shared media, shared links, account conversation
preferences, storage usage, and explicitly scoped personal clearing. DMs retain
groups in common rather than a redundant two-person participant section.
Sender-only **Message info** remains in each sent message's actions. It uses the
send-time audience and receipt privacy rules from Phase 2: departed recipients
are retained, legacy receipt history is marked incomplete, and private DM reads
are not presented as confirmed unread. Open receipt dialogs and conversation
information reconcile profile, privacy, membership, role, and room changes.

Shared links list 25 source messages per page with a sequence cursor. Only
HTTP(S) links are rendered, as external links without opener access. Source links
use the existing message navigation/highlight behavior. Deleted and personally
cleared messages are excluded. Encrypted links are extracted on the device from
available decrypted cached messages; the UI explicitly says this is incomplete
coverage. While online, encrypted information views revalidate cached message IDs
against authorized snapshots before using their bodies. Offline views can only
reflect available local data, not deletions that have not reached the device.
The API does not inspect encrypted text or fetch external websites.

Storage shows two distinct scopes:

- Visible attachments in this conversation on the server (encrypted size includes
  encryption overhead).
- This account's cached media **across all conversations on this browser/device**.

Removing downloaded copies requires confirmation, removes only that account's
media cache, and refreshes usage. It does not remove other accounts' files,
server originals, messages, keys, or pending outbox uploads. Files must be
fetched again to use them offline; an already-open viewer may retain its in-memory
copy until closed. Browser storage can also be evicted by the browser.

## Permissions

| Action                                              | Admin       | Participant                         |
| --------------------------------------------------- | ----------- | ----------------------------------- |
| Send messages and active typing/recording           | Yes         | `member_can_send` (default true)    |
| Create invitation links                             | Yes         | `member_can_invite` (default false) |
| Revoke links, review requests, change room settings | Yes         | No                                  |
| Edit room information/photo, promote/remove members | Yes         | No                                  |
| Hand over own admin role                            | Yes         | No                                  |
| DM, report/block another participant; leave         | Yes         | Yes                                 |
| Clear own history, mute, pin/archive                | Own account | Own account                         |

DMs have no group administration or invitation controls. Handover requires an
active existing participant and confirmation, promotes that participant and
demotes the caller in one transaction, and leaves other admins unchanged. It
neither leaves the room nor rewrites the historical creator attribution. Existing
last-admin leave/removal protections remain. Room-row locks serialize policy,
join, removal, role, clearing, and handover mutations. Server authorization is
always enforced even if a client displays stale controls. New sends are checked
after the existing idempotency lookup, so retrying an already accepted message
cannot duplicate it or be mistaken for a forbidden new send.

## Invitations and approval

Invitation links use `/join#token=...`; tokens are not put in query strings or
normal HTTP request paths. The browser retains a pending token in session storage
through sign-in, removes the fragment, and sends it in authenticated POST bodies.
Do not add request-body logging of these tokens. Storage contains only the SHA-256
hash; the raw link is shown once at creation and cannot be recovered from the
management list. A maximum of 50 active links is allowed per room.

Creators choose expiry (1–720 hours, default 168) and maximum admissions
(1–10000, default 100). Each successful new admission consumes one use, including
approval. Pending requests consume none. Revocation, expiry, exhaustion, and
concurrent admission are rechecked under the room/invitation lock. Invalid links
reveal no private room metadata or history. Existing members retain their normal
membership independently of a link's later revocation.

`join_approval` defaults false. When enabled, public joins and invitation joins
create a pending request without membership or message/media access. Admins can
approve/decline in room information. Approval rechecks invitation validity and
encryption-device readiness. A status check never submits a new request after a
decline; reapplying is an explicit action. Direct addition by an admin remains an
explicit admin admission and does not require a second approval. Encrypted direct
additions also require an approved active device.

## History and encryption policy

Current members can read server-readable history, including history before joining,
except messages cleared by their own account. Leaving/removal revokes subsequent
authorized API, synchronization, realtime, and media access. Approval applicants
have no membership access. Blocking does not erase shared-group history.

New encrypted-room members need an approved, active encryption device. Membership
makes them eligible for future envelopes; it does not disclose old message keys.
Additional devices follow the existing explicit encrypted key-transfer/recovery
flow. A server membership change cannot erase plaintext, downloaded files, keys,
or screenshots already held on a device. Short-lived media links already issued
retain their existing expiry; this is not a promise of recalling downloaded data.
Public/legacy server-readable rooms are not silently converted to encryption.

## Preferences and clearing

| Setting/action                       | Scope                                     | Offline behavior                                           |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------------------------- |
| Mute, pin, archive                   | Account + conversation                    | Save needs API; an error is shown if it fails              |
| Global notification/privacy settings | Account                                   | Existing settings workflow                                 |
| Clear for me on all devices          | Account + conversation                    | Needs API confirmation; never silently becomes device-only |
| Clear on this device only            | Account + conversation + this browser     | Local timestamp, works offline                             |
| Remove downloaded copies             | Account + this browser, all conversations | Local cache only                                           |

Mute suppresses conversation interruptions subject to global notification settings;
unmuting does not override a global opt-out or browser permission. Pin and archive
organize the conversation list. Saved partial preference patches compose across
independent fields; concurrent writes to the same field use the last committed
value. Durable private change records reconcile other devices, resume/reconnect,
and missed events. API responses and retries are fenced to the originating account
so a late request cannot be replayed as a newly signed-in account.

Account clearing records a monotonic server sequence boundary, independently of
membership, so leaving and rejoining does not restore cleared history. A separate
marker handles old unsequenced messages and an empty conversation. Message lists,
anchors, authorized snapshots, shared links/media, search, pins, attachment fetch
and signing, chat previews, notification visibility/unread counts, and digest
queries honor the boundary. Other participants' copies and server objects remain.
It does not forge a read receipt or acknowledge media. Device-only clearing uses
a local timestamp and does not affect server unread counts or other devices.

Replies to unavailable history retain an unavailable-source state and cannot
navigate to a hidden source. Locally decrypted encrypted search/media/links also
apply personal boundaries. Pending outbox messages are preserved and remain
visible; a later accepted send receives a new sequence and appears after the clear.
Clearing is a display/history action, not cryptographic erasure or deletion of
independent collaboration records (tasks, decisions). It is not a backup wipe.

## API additions

All routes require authentication; room actions require current membership and
appropriate admin permission. IDs are UUID-validated, writes rate-limited.

| Method/path under `/api/rooms`          | Purpose                                                             |
| --------------------------------------- | ------------------------------------------------------------------- |
| `GET /:roomId/management`               | Own preferences/clear state, scoped storage, admin invites/requests |
| `PATCH /:roomId/settings`               | Boolean `join_approval`, `member_can_send`, `member_can_invite`     |
| `POST /:roomId/invitations`             | `{expiresInHours,maxUses}`; returns raw token once                  |
| `DELETE /:roomId/invitations/:inviteId` | Admin revocation                                                    |
| `POST /invitations/accept`              | `{token}`; joined or pending                                        |
| `POST /invitations/status`              | `{token}`; read-only available/pending/rejected/joined              |
| `POST /:roomId/requests/:userId`        | `{decision:'approved'                                               | 'rejected'}` |
| `POST /:roomId/handover`                | `{successorId}`; atomic promotion/demotion                          |
| `POST /:roomId/clear`                   | Own monotonic `cleared_sequence`/`cleared_at`                       |
| `GET /:roomId/links?before=<sequence>`  | `{messages,nextCursor}`; encrypted rooms use local data             |

The existing public join endpoint returns `status: 'pending'` when approval is
required; clients must not navigate into history until membership is granted.
Management responses bound invite/request lists to 50/100; reviewing requests
refreshes the list to expose the next pending entries.

## Validation limits

Automated browser checks use real disposable PostgreSQL/Redis/API instances and
mocked R2, with Chromium desktop/mobile emulation. They do not establish deployed
R2 configuration, physical-device behavior, independent encryption security, or
production load readiness. Those remain in Phases 5/7 and GH-01–GH-05/GH-17 onward.

### Local verification recorded on 23 October 2026

- Backend unit checks: 39 passed.
- Client assertions: 84 passed.
- PostgreSQL/Redis suite: 246 passed, 0 failed, 6 live-R2 checks skipped.
- Chromium desktop/mobile: 12 security/voice/Phase 6 cases and 38 recovery cases passed.
- Production client build and whitespace checks passed.

Run substantial suites sequentially on smaller development machines:

```bash
cd backend
npm run migrate
npm test
R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= node --test --test-concurrency=1 tests/*.test.js
cd ../client
npm test
npx playwright test --config playwright.security.config.js
npx playwright test --config playwright.recovery.config.js
npm run build
```

The database/browser suites need local PostgreSQL and Redis and permission to
create disposable databases. The browser fixtures mock R2; clearing the two R2
variables above deliberately skips live-provider round trips, not failed tests.
