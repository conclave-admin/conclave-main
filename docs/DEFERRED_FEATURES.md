# Deferred feature designs

Decision recorded 24 November 2026: the items below document deferred product
work and beta boundaries. Sections explicitly mark capabilities now implemented
in the working tree. Messages and attachments are server-readable.

## Platform moderation and appeals

- Current: the protected report inbox supports case assignment, audited
  transitions, suspension/restoration, and an appeals queue. Suspended users
  can appeal through a public credential-verified page; report subjects can
  appeal actioned reports. Appeals require a different reviewer from the person
  who made the original decision. Reporter identity remains hidden in triage.
- Outcome: explicitly appointed platform moderators can investigate and resolve reports. Room admins receive no platform-wide report access.
- Approach: report assignments and appeal assignments are scoped to active
  platform moderators. Reviewers claim or are assigned cases; immutable audit
  rows record assignment and every state transition. Suspension appeals use
  account credentials because suspended sessions cannot authenticate.
- Beta boundary: assignment, appeals and suspension restoration on a reversed
  appeal are implemented. Automated assignment, appeal deadlines/notifications,
  and direct platform-wide message removal remain out of scope.
- Authorization/privacy: deny ordinary users, room admins and revoked sessions; audit both reads and actions. Avoid exposing unrelated messages or reporter identity unnecessarily.
- Dependencies: operator database access to provision roles; a named moderator and
  support contact; explicit retention and escalation policy.
- Decisions: response targets, reporter disclosure, suspension duration,
  formal evidence retention and who can perform urgent content takedown.
- Acceptance: regression coverage is authored for authorization, bounded context,
  concurrent transitions, suspension and cross-instance session revocation. It
  remains unexecuted in this pass at the user's request; run it before beta.
  Assignment and appeal authorization, reviewer separation, credential-verified
  suspended-user submission and appeal reversal also need execution before beta.

## Storage quotas

- Current: file-size and request-rate limits exist; no room/team aggregate storage quota. Deferred by user decision.
- Outcome: predictable storage use with clear quota feedback before expensive transfers.
- Approach: transactional byte reservations for uploads; charge finalized canonical objects once, release abandoned reservations and reconcile cleanup. Define attribution for shared/forwarded files before introducing counters.
- Authorization/privacy: only authorized room/team operators see usage; backend owns counters and membership checks.
- Dependencies: storage ownership model, cleanup-job accounting and billing/product limits.
- Decisions: byte limits, per-user versus team/room ownership, legacy usage, over-limit behavior, reservation expiry and account/team deletion.
- Acceptance: concurrent uploads cannot exceed a cap; cancellation/failure frees reservations; retries do not double-charge; existing over-limit data remains readable under an explicit policy.

## Malware scanning

- Current: MIME, magic-byte and size validation do not establish that content is
  harmless. Scanning remains deferred only for a small personally known beta
  cohort whose signup URL is distributed selectively. A numeric account cap by
  itself does not make an open signup population trusted. Beta operations and a
  takedown escalation are documented in `BETA_OPERATIONS.md`.
- Outcome: attachments become distributable only after an approved scanner result.
- Approach: quarantine object keys, durable scan jobs, bounded retry and explicit pending/clean/rejected/error states. Validate results server-side and preserve authenticated downloads.
- Authorization/privacy: limit scanner access to necessary objects, prohibit public quarantine URLs and document provider processing/retention.
- Dependencies: approved provider or managed ClamAV infrastructure, resource
  limits and budget. Public promotion, repeated malicious uploads, or inability
  to complete takedown are stop conditions that require scanning before signup
  or upload acceptance resumes.
- Decisions: provider, supported archives/encryption, timeout/failure policy, rescanning and appeals/false positives.
- Acceptance: EICAR rejected, pending files inaccessible, spoofed callbacks rejected, retries idempotent, scanner outage handled visibly without silently bypassing scanning.

## OS notification actions

- Current: message notifications provide Mark as read and Open chat actions
  where the browser supports notification buttons. Default click navigation
  remains available everywhere.
- Beta boundary: Mark as read uses a short-lived, single-use token scoped to one
  notification, push subscription/session and visible room-message boundary. It
  rechecks session, membership, blocks and message visibility server-side; the
  service worker does not hold a general API token. Reply text is not sent from
  the notification.
- Outcome: supported platforms allow authenticated, predictable actions without opening unrelated content.
- Approach: scoped Mark as read and Open chat actions are implemented.
  Unsupported platforms retain ordinary click navigation. Inline reply remains
  a separate future decision.
- Authorization/privacy: recheck session and membership; no long-lived credentials or sensitive content embedded in action payloads.
- Dependencies: supported-browser matrix, authenticated worker-to-API strategy and live push acceptance.
- Decisions: action set, reply UX, offline retry, read boundary and multi-device semantics.
- Acceptance: denied/expired sessions do not mutate data; duplicate actions are safe; only the intended room is marked; unsupported platforms still open correctly.

## Recurring quiet hours

- Current: account preferences support a weekly schedule with selected days,
  start/end times and an IANA time zone. Overnight windows and local weekday
  boundaries are evaluated in that time zone. Manual DND and room mute-until
  continue to work alongside it.
- Beta boundary: recurring quiet hours are implemented for push and in-app
  message alerts. Bell history, unread counts and message delivery continue
  during quiet time.
- Outcome: users define recurring quiet periods consistently across devices.
- Approach: store timezone-aware weekly windows and evaluate one shared policy for push, sound and in-app alerts while leaving bell history available.
- Authorization/privacy: preference writes are account-scoped; quiet hours never broaden suppressed notifications.
- Dependencies: settings API and notification preferences migration 070.
- Decisions: schedules follow the saved time zone while travelling; users can
  change it explicitly. There is no urgent-notification exception.
- Acceptance: API and policy regression coverage verifies validation, timezone
  selection, overnight/week-boundary windows, push/in-app parity and partial
  preference updates. Real-device timezone changes remain part of beta browser
  acceptance.

## Cross-room search

- Current: ranked cross-room search covers visible messages, decisions, tasks,
  file names, rooms and people. Users can filter by result type, room, author
  and date range, choose relevance or recent ordering, and page through results.
- Beta boundary: implemented with bounded result sets per type. Stable cursor
  pagination and query-performance tuning for very large histories remain future
  hardening work.
- Outcome: users search only content and people they can currently access.
- Approach: server-side queries apply room membership and message-history
  visibility before returning results; a bounded relevance score favors title
  matches and recent content.
- Authorization/privacy: membership revocation, personal clearing, expiry and deletion apply to snippets, links, counts and cached results.
- Dependencies: database query-performance measurements as beta usage grows.
- Decisions: stable cursor semantics and richer attachment metadata search.
- Acceptance: type/room/author/date filters combine correctly; removed
  membership and cleared/deleted messages disappear; no private snippets leak.
  These paths were not tested in this no-test implementation pass.

## Voice calling

- Current: authenticated WebRTC audio/video calls work in direct and group
  rooms. Invitations, ringing, accept/decline, participant signaling, hang-up,
  missed-call expiry and recent history are persisted. Group mesh is capped at
  four people, including the caller.
- Beta boundary: foreground calling and call history are implemented. A generic
  web push can open the app to answer; the browser must be foregrounded before
  microphone/camera access is requested. Native/background call acceptance is
  not available.
- Outcome: authorized one-to-one and small-room audio/video calls with clear
  participant and end states.
- Approach: Socket.IO relays only bounded, transient SDP and ICE signaling;
  browser media is peer-to-peer or routed through a configured TURN server.
  Call metadata is retained in participant-scoped history. No media is recorded.
- Authorization/privacy: room membership, direct/group room type, blocks,
  active account and session are checked for invitations, acceptance and every
  signal. Session revocation, membership loss and blocking end the call.
  Peer-to-peer calls reveal network addresses to the other participant;
  TURN infrastructure and its operator may observe relayed network metadata.
- Dependencies: HTTPS, supported browser media APIs, live Web Push for offline
  ring notices, and TURN credentials for networks that cannot connect peer to
  peer. `RTC_TURN_URLS` and `RTC_TURN_SHARED_SECRET` use time-limited coturn REST
  credentials; no TURN provider is configured by this change.
- Decisions: mesh limit is four total participants; calls ring all room
  members. Large-room SFU calls, notification-screen acceptance and recording
  remain out of scope.
- Acceptance: code now handles denied permissions, busy calls, missed rings,
  duplicate answers, participant departure and session/block revocation. The
  requested no-test pass means these paths have not been run; live TURN, Web
  Push, NAT traversal and real-device acceptance remain pending.

## Video and group calls

- Current: audio and video use peer mesh for rooms up to four participants.
- Beta boundary: available for direct and small group rooms; a larger group
  receives a capacity error rather than starting an unsupported call.
- Outcome: participants can mute their microphone, disable their camera, see
  remote video and leave independently.
- Approach: each joined participant negotiates pairwise WebRTC connections;
  no media server or screen sharing is included.
- Authorization/privacy: every peer connection is preceded by server-side
  membership, block and active-call checks. Leaving or losing access closes the
  participant's connections.
- Dependencies: TURN configuration and supported browser media APIs.
- Decisions: mesh capacity is four; an SFU and screen sharing remain future work.
- Acceptance: implementation is present but was not exercised in this
  no-test pass; capacity, poor-network behavior and camera/device acceptance
  remain pending.

## Call history and background calling

- Current: the latest 100 calls per account show caller, room, type, outcome,
  start time and duration. Incoming web push opens the authenticated app to the
  expiring incoming-call prompt.
- Beta boundary: history and click-through incoming call delivery are
  implemented. Accepting while the app is closed or directly from the OS
  notification is not supported.
- Outcome: recent missed, declined, cancelled and completed calls are visible
  across signed-in devices.
- Approach: durable call IDs and participant rows make answers and departures
  idempotent. History is limited to calls the viewer joined and hides blocked
  peers.
- Authorization/privacy: current account, call participation, active room
  membership and block checks apply; session revocation closes active calls.
- Dependencies: browser push setup and call migrations through 072.
- Decisions: history keeps the most recent 100 rows; media is never recorded.
- Acceptance: multi-device answer races are guarded by row locks. No tests or
  live push/device acceptance were run in this pass.

## Room events

- Current: room-scoped scheduling, editing, cancellation, RSVP counts and
  durable event reminders are implemented. Member access is checked on reads,
  responses and reminder delivery; organizers and room admins manage events.
- Beta boundary: the feature is implemented for one-time events. Recurrence,
  all-day events and event-history restoration remain out of scope.
- Outcome: authorized room members create, discover and respond to coordination events.
- Approach: room-scoped events with timezone-aware times, RSVP state and durable reminders; add recurring events only after recurrence behavior is specified.
- Authorization/privacy: room membership controls reads and RSVP; explicit organizer/admin rights govern edits/cancellation; recheck reminder recipients at delivery.
- Dependencies: migration 073, notification preferences, existing push queue
  and the shared experience worker.
- Decisions: all-day/recurring events, timezone display, RSVP visibility, edit permissions and cancellation history.
- Acceptance: removed members cannot read/respond or receive future reminders;
  time edits replace reminder jobs; duplicate jobs do not duplicate notices;
  cancellation sends an authorized in-app/push notice. No tests were run in
  this implementation pass, so DST/browser/provider acceptance is still pending.
