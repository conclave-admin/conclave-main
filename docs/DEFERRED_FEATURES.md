# Deferred feature designs

Decision recorded 23 November 2026: this release fixes existing behavior. These
features are not implemented by that work. Messages and attachments are
server-readable. Proposed approaches below require their listed decisions before
implementation; they are not enabled product behavior.

## Platform moderation

- Current: platform moderators and administrators have a protected report inbox,
  bounded nearby message context, audited report reads and concurrency-safe
  status transitions. They can suspend/restore accounts; suspension blocks
  requests, login and refresh and revokes active sessions. Moderator roles are
  provisioned by an operator script. Reporter identity is not shown in triage.
- Outcome: explicitly appointed platform moderators can investigate and resolve reports. Room admins receive no platform-wide report access.
- Approach: implemented for the controlled beta. Assignment, appeals and direct
  moderator content removal remain unimplemented.
- Authorization/privacy: deny ordinary users, room admins and revoked sessions; audit both reads and actions. Avoid exposing unrelated messages or reporter identity unnecessarily.
- Dependencies: operator database access to provision roles; a named moderator and
  support contact; explicit retention and escalation policy.
- Decisions: response targets, appeals, reporter disclosure, suspension duration,
  formal evidence retention and who can perform urgent content takedown.
- Acceptance: regression coverage is authored for authorization, bounded context,
  concurrent transitions, suspension and cross-instance session revocation. It
  remains unexecuted in this pass at the user's request; run it before beta.

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

- Current: notifications open conversations; no Reply or Mark as read actions.
- Outcome: supported platforms allow authenticated, predictable actions without opening unrelated content.
- Approach: capability-detected service-worker actions; implement Mark as read against an explicit message boundary before considering reply input support. Unsupported platforms retain ordinary click navigation.
- Authorization/privacy: recheck session and membership; no long-lived credentials or sensitive content embedded in action payloads.
- Dependencies: supported-browser matrix, authenticated worker-to-API strategy and live push acceptance.
- Decisions: action set, reply UX, offline retry, read boundary and multi-device semantics.
- Acceptance: denied/expired sessions do not mutate data; duplicate actions are safe; only the intended room is marked; unsupported platforms still open correctly.

## Recurring quiet hours

- Current: manual mute-until/DND timestamps exist.
- Outcome: users define recurring quiet periods consistently across devices.
- Approach: store timezone-aware weekly windows and evaluate one shared policy for push, sound and in-app alerts while leaving bell history available.
- Authorization/privacy: preference writes are account-scoped; quiet hours never broaden suppressed notifications.
- Dependencies: policy parity tests and timezone/DST handling.
- Decisions: travel timezone behavior, overnight windows, DST ambiguity, manual-DND precedence and urgent exceptions.
- Acceptance: overnight/week-boundary/DST cases, preference replay and immediate changes work; muted/blocked conversations remain suppressed.

## Cross-room search

- Current: room-scoped search exists; global search is deferred.
- Outcome: users search only messages they can currently read across their rooms.
- Approach: server-side indexed search with stable pagination and membership/history-visibility predicates on every result and count. Reuse existing message visibility rules.
- Authorization/privacy: membership revocation, personal clearing, expiry and deletion apply to snippets, links, counts and cached results.
- Dependencies: query-performance measurements and consistent visibility predicates.
- Decisions: filters, ranking, attachment search, team boundary and cache invalidation.
- Acceptance: removed membership and cleared/deleted messages disappear; pagination is stable; no private counts/snippets leak; large datasets meet agreed latency targets.

## Voice calling

- Current: voice messages exist; synchronous calling does not.
- Outcome: authenticated one-to-one audio invitations, ringing, accept/decline and hang-up.
- Approach: separately design WebRTC signaling, TURN/STUN infrastructure and durable call state before implementation. Use expiring authorized signaling identities and session-aware multi-device ringing.
- Authorization/privacy: block/membership/session checks on invitation and join; document media transport guarantees and IP exposure.
- Dependencies: TURN provider, budget, device/browser support and call-state architecture.
- Decisions: supported networks, timeout/busy behavior, device handoff, background support, recording policy and accessibility.
- Acceptance: permission denial, NAT traversal, blocked caller, revoked session, reconnect, duplicate accept and remote hang-up work on agreed real devices.

## Video and group calls

- Current: no synchronous video/group call infrastructure.
- Outcome: authorized participants control camera/microphone and see reliable join/leave state.
- Approach: build on the voice-call state model; select mesh versus SFU using participant/capacity targets. Specify stream ownership, bandwidth adaptation and screen sharing separately.
- Authorization/privacy: recheck invite/join rights and remove revoked participants; clearly indicate active capture.
- Dependencies: voice signaling, media topology/provider and capacity budget.
- Decisions: participant limits, media encryption guarantees, moderator controls, screen sharing and failure recovery.
- Acceptance: unauthorized joins fail; device switching and participant removal work; poor-network behavior stays usable; agreed capacity and real-device tests pass.

## Call history and background calling

- Current: no call history or incoming-call lifecycle.
- Outcome: consistent missed/answered/declined/ended history across authorized devices.
- Approach: durable call IDs and idempotent transitions, participant-scoped history and synchronized device acknowledgements. Treat OS/background ringing as a separate supported-platform contract.
- Authorization/privacy: restrict history and caller metadata; apply block, deletion and retention policies.
- Dependencies: implemented call state, push acceptance and mobile/background platform decisions.
- Decisions: retention, clearing versus deletion, missed-call definition, multi-device answer races and notification grouping.
- Acceptance: one answered call stops other ringing devices; duplicates do not create history rows; offline recovery converges; revoked devices lose access.

## Room events

- Current: no room-event scheduling/RSVP feature.
- Outcome: authorized room members create, discover and respond to coordination events.
- Approach: room-scoped events with timezone-aware times, RSVP state and durable reminders; add recurring events only after recurrence behavior is specified.
- Authorization/privacy: room membership controls reads and RSVP; explicit organizer/admin rights govern edits/cancellation; recheck reminder recipients at delivery.
- Dependencies: event ownership, notification policy and durable reminder processing.
- Decisions: all-day/recurring events, timezone display, RSVP visibility, edit permissions and cancellation history.
- Acceptance: removed members cannot read/respond; DST and time edits reschedule reminders; duplicate jobs do not duplicate reminders; cancellation reaches authorized attendees.
