# Recoverable synchronization and browser push

## Synchronization

Apply migrations `034_recoverable_changes.sql` and `035_background_push.sql`
with `npm run migrate` before starting the updated API. Deploy the API and client
together. Existing messages need no backfill: the first replay performs a full
authorized reconciliation of the client's loaded and cached messages.

Database triggers append identifier-only changes in the transaction that changes
messages, reactions, polls, pins, rooms, memberships, profiles, preferences,
blocks, or notifications. Cursors are assigned to committed records under a
separate allocator lock. A transaction that commits late cannot be skipped by a
cursor that was already acknowledged.

The API runs a durable delivery worker every two seconds. Leases and fencing
tokens allow multiple API instances to claim work safely. A crash between a
message commit and broadcast leaves work available for another process; message
notification recovery uses recipient/type/reference deduplication. Socket hints
can be repeated. They carry no message content and are never the source of truth.

The client reads `/api/sync`, fetches authorized snapshots, updates its caches,
then saves its account-specific cursor. It retries failed replay and checks on
reconnect, foreground, online, and every 15 seconds, including when the socket
is unavailable. Message state and sender profiles have separate versions so a
late response cannot undo an edit or profile change. Tombstones remain deleted;
pending outbox entries remain intact. Media upload failures still require manual
retry with their original failure reason.

Delivered changes are retained for 30 days; undelivered changes are retained.
Expired, future, or absent cursors request a full authorized snapshot. Current
membership is checked on every replay and message snapshot request. Personal
pins, preferences, and notifications are private invalidations. Membership
removal invalidates access and cached content rather than returning room data.

## Enable Web Push

1. From `backend/`, generate one key pair:

   ```sh
   node -e 'console.log(JSON.stringify(require("web-push").generateVAPIDKeys(), null, 2))'
   ```

2. Store `publicKey` as `VAPID_PUBLIC_KEY` and `privateKey` as
   `VAPID_PRIVATE_KEY` in the backend environment. Use the same pair on every
   instance. Keep the private key in your secret manager and out of Git.
3. Set `VAPID_SUBJECT` to your real public `mailto:` contact or HTTPS contact
   page. No project contact is assumed. Push stays disabled until all three
   values are configured. `/api/push/config` exposes only the public key.
4. Restart the API. Serve the client over HTTPS (localhost is supported for
   development). In Settings, enable background alerts, then select **Enable in
   this browser**. Permission is requested only from that user gesture.

Default supported endpoints include Google's FCM, Mozilla, Apple, and Windows
push providers. `PUSH_ALLOWED_ORIGINS` can allow additional exact HTTPS provider
origins. Do not add arbitrary user-controlled origins. Normal API CORS still
must allow the deployed frontend.

The subscription is bound to the authenticated account and login session. The
service worker stores a scoped, rotating push-renewal credential, not API login
tokens. Logout clears the local binding and subscription; server session
revocation also removes subscriptions and queued work. Browser denial displays
instructions; explicit device opt-out persists across focus and reconnect.
Expired provider subscriptions (404/410) are removed. Subscription rotation is
renewed through `/api/push/renew`; a signed-in page also repairs registrations on
focus/online. When the browser does not deliver subscription-change events,
repair requires reopening the app.

## Delivery policy

Notifications and push jobs are persisted atomically. The push worker checks
current membership, symmetric blocking, unread state, deleted messages, global
push preference, activity level, per-type preferences, room mute, and fresh
foreground presence before each attempt. **Mentions only** permits only mentions;
room mute and per-type mute still take precedence. Redis outages defer delivery.

Browser payloads and lock-screen previews contain generic Conclave activity,
never message text or sender names. The worker checks account/session binding
and suppresses a visible focused conversation. Notification clicks open the
same-origin notifications page. Duplicate provider deliveries use a stable
notification tag. Delivery is at least once, not exactly once: an accepted push
followed by a worker crash may be sent again. Provider acceptance does not prove
that an OS displayed an alert.

Transient provider errors and 429 responses retry with backoff/Retry-After;
pending alerts expire after 15 minutes. Completed jobs are retained for 30 days.
Bell records remain available for muted conversations; blocked or revoked live
targets are filtered consistently from the list and unread total. Clients always
refresh the authoritative total after seen/replayed events instead of subtracting
event deltas.

## Verification and rollout

Automated checks cover real PostgreSQL migrations and authorization, a Redis
adapter with two API instances, missed broadcasts, replay, lost acknowledgements,
mocked push-provider failures/expiry, subscription renewal/logout, and service
worker delivery/click handling. Playwright covers desktop/mobile reconciliation,
notification convergence, and explicit permission/opt-out behavior with mocked
server and browser push boundaries.

Before marking live push acceptance complete:

1. Configure the real VAPID contact/key pair and deploy API/client together.
2. Subscribe two accounts on separate supported browsers/devices.
3. Background and close the receiving app, then send a message. Check delivery
   on the intended device and click through to the authenticated app.
4. Repeat with global/type/room mute, block, foreground conversation, logout,
   denied permission, and an expired subscription. Confirm suppression.
5. Disconnect a device; edit, delete, react, change profiles/roles, and remove a
   member from another device. Reconnect and verify authorized convergence.
6. Restart an API process after persistence but before a hint is delivered;
   confirm replay repairs the client and retries do not duplicate messages.

Browser/OS power settings and platform Web Push support affect live delivery.
Automated mocks do not certify real provider or lock-screen behavior.

References: [web-push VAPID API](https://github.com/web-push-libs/web-push),
[PushManager.subscribe](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe),
[service worker push event](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/push_event).
