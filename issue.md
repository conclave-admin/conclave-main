# Conclave messaging quality and feature tracker

Created: 22 October 2026  
Source: current-code assessment supplied by the user  
Scope: messaging reliability, privacy, presence, typing, DMs, rooms, media, and collaboration

## How to track progress

- `[ ]` means outstanding; `[x]` means completed with supporting evidence.
- Set each phase to **Not started**, **In progress**, **Blocked**, or **Complete**.
- Record implementation notes, verification results, and deployment requirements
  in the progress log. Link related commits or pull requests when available.
- Complete a phase only after its implementation and acceptance checks pass.
- Existing features listed below are a baseline, not proof of production parity.
  Deployment, load handling, and real-device behaviour need fresh verification.

Priorities: **P0** = access/security blocker; **P1** = core correctness or privacy;
**P2** = completeness and production validation; **P3** = broader feature parity.

## Existing baseline

These capabilities exist; their outstanding correctness and rollout work is
tracked in the phases below.

- [x] Persistent offline text and media outboxes, acknowledgements, and duplicate-send protection.
- [x] Manual upload retries with failure reasons.
- [x] Replies, reactions, editing, deletion, pins, polls, and forwarding.
- [x] Albums, captions, previews, resumable transfers, and local media caching.
- [x] Separate DM and room experiences.
- [x] Room administration, participant messaging, reporting, blocking, and leaving.
- [x] Shared-media browsing, personal clearing, and pinned/muted/archived conversations.
- [x] Decisions, tasks, and catch-up features supporting collaboration.

## Implementation order

| Phase | Priority | Work                                                              | Status      |
| ----- | -------- | ----------------------------------------------------------------- | ----------- |
| 1     | P0       | Realtime access revocation and session enforcement                | Complete    |
| 2     | P1       | Presence, typing, visibility-based reads, and group receipts      | Complete    |
| 3     | P1       | Recoverable delivery and reconnect synchronization                | Complete    |
| 4     | P1       | Background notifications and preference enforcement               | In progress |
| 5     | P1       | Privacy controls, account recovery, devices, and encryption       | Not started |
| 6     | P2       | Voice messages, info pages, rooms, and personal history           | Not started |
| 7     | P2       | Deployed media, browser CI, real devices, accessibility, and load | Not started |
| 8     | P3       | Calling, events, and further collaboration                        | Not started |

Encryption architecture needs early planning alongside phases 1–3 because it
affects the message model, media pipeline, search, and synchronization. Phase 5
tracks that work explicitly; do not finalize conflicting designs beforehand.

## Phase 1 — Realtime access revocation and session enforcement

**Priority:** P0  
**Status:** Complete

### Findings

Previously, `removeMember` deleted database membership without forcibly removing
the affected user's sockets. Phase 1 now evicts those subscriptions on every API
instance before committing removal, with database locks preventing concurrent
joins or typing from restoring access.

Reference: [rooms.controller.js](backend/src/controllers/rooms.controller.js),
`removeMember`.

### Work

- [x] **1.1** Revoke room subscriptions immediately when a participant leaves or is removed.
- [x] **1.2** Apply revocation to every connected device and API instance.
- [x] **1.3** Clean up that participant's room presence and typing state.
- [x] **1.4** Update affected clients immediately so membership and available actions agree.
- [x] **1.5** Enforce session revocation and expired-session handling for existing realtime connections.

### Acceptance checks

- [x] A removed participant cannot receive subsequent room messages or updates through an already-open socket.
- [x] Other tabs/devices and sockets connected to another API instance lose access too.
- [x] Authorized members continue receiving messages and accurate presence updates.
- [x] A revoked session cannot keep using an existing realtime connection.

Evidence: [cluster security tests](backend/tests/realtime-access.test.js),
[peer acknowledgement checks](backend/test/realtime-access.test.js),
[desktop/mobile removal checks](client/e2e/realtime-access.spec.js), and
[subscription handoff checks](client/test/roomSubscriptions.test.js).
Migration 032 is applied locally. Deployment requires a coordinated API/client
restart and existing users signing in again; see [rollout notes](DEPLOYMENT.md#phase-1-session-rollout).

## Phase 2 — Presence, typing, and receipt correctness

**Priority:** P1  
**Status:** Complete

### Presence

Original findings: presence rosters could outlive their connection, and “Active
in this chat” reflected subscriptions rather than confirmed foreground attention.
The implementation now separates per-device connectivity from foreground viewing,
invalidates uncertain client state, and restores presence indexes after outages.

References: [PresenceContext.jsx](client/src/contexts/PresenceContext.jsx),
[RoomHeader.jsx](client/src/components/chat/RoomHeader.jsx),
[presence.service.js](backend/src/services/presence.service.js).

- [x] **2.1** Distinguish connected to Conclave, viewing this conversation, typing, offline, and temporarily unknown presence.
- [x] **2.2** Clear or invalidate stale presence on disconnect and refresh it after reconnect.
- [x] **2.3** Handle foreground/background transitions and sleeping or resumed devices.
- [x] **2.4** Clean up stale device/socket indexes and recover after Redis or server restarts.

Evidence: [presence and recovery integration checks](backend/tests/realtime-access.test.js),
[foreground notification suppression check](backend/tests/integration.test.js),
[client presence and lifecycle checks](client/test/presence.test.js), and
[desktop/mobile presence checks](client/e2e/realtime-access.spec.js).
Recovery coverage includes API server restart, simulated Redis state loss,
presence-client disconnect/reconnect, and simulated SQL lookup failure. Existing
Redis service data is not flushed. Deployment needs the updated API and client;
these items add no database migrations or environment variables.

### Typing

Resolved: typing is throttled before emitting, initial and live activity have
remaining-lifetime expiry, and Redis aggregates typing/recording per device.
Foreground and membership checks, ordered stops, and symmetric block filtering
apply across server instances.

References: [MessageComposer.jsx](client/src/components/chat/MessageComposer.jsx),
[useMessages.js](client/src/hooks/useMessages.js),
[sockets/index.js](backend/src/sockets/index.js).

- [x] **2.5** Fix client throttling and add server-side typing-event rate limits.
- [x] **2.6** Expire initial typing snapshots as well as individual typing events.
- [x] **2.7** Stop typing on blur, empty input, sending, navigation, and disconnect.
- [x] **2.8** Aggregate typing across devices so one device stopping does not erase another device's activity.
- [x] **2.9** Add recording indicators and apply consistent blocking/privacy rules.

Implemented: a shared client activity store drives the timeline, DM header,
and chat list. Typing stops on blank input, blur, idle, send, navigation,
backgrounding, and disconnect. Recording pulses stop on capture completion,
backgrounding, device loss, permission cancellation, and recorder failure.
One device stopping leaves other devices visible. Lower room activity versions
cannot restore stale indicators. Blocks hide both users' ephemeral presence
and activity from each other, including in shared groups; this does not complete
the broader profile/notification blocking policy in item 5.4. No new migration
or environment variables are required for items 2.5–2.9.

### Read and delivery receipts

Resolved: visible, focused timelines acknowledge individual messages, rechecking
on resume and reconnect. Group ticks use immutable send-time recipient lists
and require all recipients. The sender can inspect first delivery/read times
and departed recipients in Message info. Older messages explicitly retain an
incomplete-history marker because previous memberships cannot be reconstructed.

References: [Room.jsx](client/src/pages/Room.jsx),
[MessageTimeline.jsx](client/src/components/chat/MessageTimeline.jsx),
[messageMeta.js](client/src/lib/messageMeta.js).

- [x] **2.10** Advance reads only when the message is visible in an active application view.
- [x] **2.11** Re-evaluate visible messages when returning from the background.
- [x] **2.12** Define group sent/delivered/read semantics and apply them consistently.
- [x] **2.13** Add per-recipient delivery/read information.
- [x] **2.14** Preserve relevant recipient history when membership changes.

Implementation: [messageReceipt.service.js](backend/src/services/messageReceipt.service.js),
[migration 033](backend/database/migrations/033_message_receipts.sql),
[messageReads.js](client/src/lib/messageReads.js), and
[MessageInfoDialog.jsx](client/src/components/chat/MessageInfoDialog.jsx).
Exact-message receipts preserve unread gaps; badge counts exclude later messages
already read. Summaries have monotonic versions, refresh after reconnect even
for historical anchors, and keep send-time recipients through membership changes.
Explicit mark-all-read commands update the same durable receipt store.

### Acceptance checks

- [x] Disconnect, reconnect, backgrounding, and multi-device scenarios produce accurate presence.
- [x] Typing expires without a final stop event and does not emit once per keystroke.
- [x] Hidden/background conversations do not incorrectly advance read receipts.
- [x] DM and group receipt displays match the documented rules, including after membership changes.

## Phase 3 — Recoverable delivery and reconnect synchronization

**Priority:** P1  
**Status:** Complete

### Findings

Previously, reconnect only fetched messages after the latest known sequence.
Older edits, deletions, and reactions could remain stale. Replay now invalidates
those messages independently of their original sequence.

Implemented with a committed change journal, authorized replay, versioned message
and profile snapshots, cache reconciliation, and durable broadcast recovery.
See [synchronization and push](docs/SYNC_AND_PUSH.md) for delivery guarantees.

### Work

- [x] **3.1** Introduce a synchronization cursor/change replay mechanism, or equivalent history reconciliation.
- [x] **3.2** Recover new messages, edits, deletions, reactions, and related message state after disconnection.
- [x] **3.3** Recover room details, membership, roles, and profile changes.
- [x] **3.4** Make saved-message event delivery recoverable across server failures between persistence and broadcast.
- [x] **3.5** Keep acknowledgements and duplicate protection consistent across retries and devices.
- [x] **3.6** Converge cached and server state without losing pending messages or resurrecting deleted content.

### Acceptance checks

- [x] Changes made while a device is offline appear correctly after reconnect without a manual refresh.
- [x] Server restart and lost-acknowledgement scenarios do not lose or duplicate messages.
- [x] Two devices converge on the same authorized conversation state.

Evidence: PostgreSQL/Redis checks exercise committed replay, late commits,
removed-member authorization, private pins, profile/role changes, notification
deduplication, and recovery after a simulated persistence/broadcast failure.
Browser and unit checks cover reconnect, missed hints, tombstone preservation,
pending drafts, and cursor persistence only after successful reconciliation.

## Phase 4 — Background notifications and preference enforcement

**Priority:** P1  
**Status:** In progress — implementation complete; live push acceptance pending

### Findings

Added durable browser Web Push with session-bound subscriptions, permission
controls, renewal, and current interruption policy checks. Bell records/counts
refresh authoritatively across reconnects and devices. Real provider delivery
requires a configured VAPID contact/key pair and supported browser/device checks.

- [x] **4.1** Implement actual background push delivery for supported clients.
- [x] **4.2** Manage push permission, subscription registration, refresh, and removal.
- [x] **4.3** Apply global, per-type, and per-conversation notification preferences to interruptions.
- [x] **4.4** Keep blocking and active-conversation suppression consistent with notification delivery.
- [x] **4.5** Keep unread counts and notification state consistent after reconnect and across devices.

### Acceptance checks

- [ ] Supported background/closed-app scenarios receive the intended notifications.
- [x] Muted or blocked conversations do not cause unintended interruptions.
- [x] Permission denial, logout, and expired subscriptions are handled cleanly.

Evidence: real database/subscription checks with a mocked push provider and
service-worker/browser tests. The background/closed-app handler is verified with
mocks; real OS delivery remains unchecked. Configure the VAPID variables and
complete the [live rollout checklist](docs/SYNC_AND_PUSH.md#verification-and-rollout)
before marking this phase Complete.

## Phase 5 — Privacy, account security, devices, and encryption

**Priority:** P1; establish architecture early  
**Status:** Not started

### Privacy and DMs

- [ ] **5.1** Add last-seen and online visibility controls.
- [ ] **5.2** Define profile/photo visibility and read-receipt privacy controls.
- [ ] **5.3** Add message requests or controls for unknown users.
- [ ] **5.4** Apply blocking consistently to DMs, typing, presence, profile visibility, and notifications according to a documented policy.

### Account and device security

- [ ] **5.5** Implement account recovery and email verification.
- [ ] **5.6** Provide device/session management and remote logout.
- [ ] **5.7** Integrate those controls with the session enforcement in phase 1.

### End-to-end encryption

Current messages are server-readable. Authenticated R2 access controls do not
provide end-to-end encryption.

- [ ] **5.8** Decide and document the encryption scope for DMs and rooms.
- [ ] **5.9** Design device identity keys, verification, and secure device linking.
- [ ] **5.10** Implement message and attachment encryption on the device within the chosen scope.
- [ ] **5.11** Design and implement secure key recovery and encrypted backups.
- [ ] **5.12** Decide how search, decisions, tasks, digests, and moderation work with encrypted content.

### Acceptance checks

- [ ] Privacy and blocking controls behave consistently across API, realtime, and background delivery.
- [ ] Recovery and remote logout work across devices, including already-open sessions.
- [ ] Encryption guarantees and recovery limitations are documented and verified before making product claims.

## Phase 6 — Voice messages, information pages, rooms, and personal history

**Priority:** P2  
**Status:** Not started

### Voice messages

Recording exists; received audio currently follows the generic file-card path.

- [ ] **6.1** Add inline audio playback with seeking, duration, and playback speed.
- [ ] **6.2** Add recording preview and discard controls.
- [ ] **6.3** Integrate playback with cached/offline media and the recording indicators in phase 2.

### Information pages

- [ ] **6.4** Expose the per-message delivery/read information from phase 2.
- [ ] **6.5** Add shared-link browsing alongside shared media.
- [ ] **6.6** Make conversation notification controls clearer.
- [ ] **6.7** Show useful storage information.
- [ ] **6.8** Refresh information pages live after membership, role, room, or profile changes.

### Rooms

- [ ] **6.9** Add revocable invitation links.
- [ ] **6.10** Add optional join approval.
- [ ] **6.11** Add configurable participant permissions.
- [ ] **6.12** Define membership/history access policy.
- [ ] **6.13** Provide a guided admin handover flow.

### Multi-device personal actions

- [ ] **6.14** Synchronize conversation preferences across devices.
- [ ] **6.15** Define account-wide versus device-only personal clearing and implement the intended behaviour.
- [ ] **6.16** Synchronize personal history actions without globally deleting other participants' messages.

Current “Clear for me” uses a device-local timestamp. Message edits, deletions,
and membership synchronization are tracked in phase 3.

### Acceptance checks

- [ ] Voice notes can be recorded, previewed, discarded, played, and reopened offline as designed.
- [ ] Info pages stay current without manual reload and enforce the same permissions as their actions.
- [ ] Revoked invites, join approval, and admin handover work under concurrent changes.
- [ ] Personal history actions have clearly labelled, consistent device/account scope.

## Phase 7 — Production validation, performance, and moderation

**Priority:** P2  
**Status:** Not started

### Media rollout

- [ ] **7.1** Reverify R2 bucket CORS and incomplete-upload lifecycle configuration.
- [ ] **7.2** Reverify the deployed preview Worker, transformation bindings, signing, and browser CORS behaviour.
- [ ] **7.3** Complete deployed real-browser upload/download checks, including access controls and recovery.

Related checklist: [WHATSAPP_MEDIA_ROADMAP.md](WHATSAPP_MEDIA_ROADMAP.md).
Storage setup: [docs/MEDIA_STORAGE.md](docs/MEDIA_STORAGE.md).
Previously identified rollout gaps need fresh checks; this tracker does not
assume the deployed configuration is unchanged.

### Performance and resilience

- [ ] **7.4** Introduce large-history virtualization where needed.
- [ ] **7.5** Bound memory usage for long conversations and media-heavy sessions.
- [ ] **7.6** Apply fair rate limits consistently across API instances and transports.
- [ ] **7.7** Run sustained load and network-failure scenarios.

### Verification and delivery

- [ ] **7.8** Add browser messaging coverage to CI alongside unit and database checks.
- [ ] **7.9** Verify supported real devices and browsers, including mobile keyboard/background behaviour.
- [ ] **7.10** Verify accessibility, keyboard navigation, screen-reader use, and reduced-motion behaviour.
- [ ] **7.11** Record deployed verification evidence and unresolved release blockers.

### Moderation operations

Reporting exists; the review and enforcement workflow remains to be completed.

- [ ] **7.12** Provide report review, investigation, and enforcement tools.
- [ ] **7.13** Document and verify the operational process for acting on reports.

### Acceptance checks

- [ ] Deployed media checks pass against the intended bucket, origins, and Worker.
- [ ] Browser CI and agreed real-device/accessibility scenarios pass.
- [ ] Load and failure scenarios meet documented reliability and resource targets.
- [ ] A submitted report can be reviewed and acted on through the moderation workflow.

## Phase 8 — Calling, events, and further collaboration

**Priority:** P3  
**Status:** Not started

Voice/video calling is a separate major project with mobile and background
requirements. Decisions, tasks, and catch-up should continue developing as
Conclave's collaboration strengths.

- [ ] **8.1** Design and implement voice calling.
- [ ] **8.2** Design and implement video calling and the intended group calling experience.
- [ ] **8.3** Add call history and associated mobile/background behaviour.
- [ ] **8.4** Define and implement group events and related coordination features.
- [ ] **8.5** Continue improving decisions, tasks, and digest workflows alongside messaging.

### Acceptance checks

- [ ] Calling works on supported devices under the agreed network/background scenarios.
- [ ] Call history and event state synchronize correctly and respect access/privacy policies.
- [ ] Collaboration workflows preserve their conversation context and permissions.

## Comparison references

These references describe WhatsApp capabilities, not proof that Conclave has
implemented or verified equivalent behaviour.

- [WhatsApp read receipts](https://faq.whatsapp.com/665923838265756/?cms_platform=web&locale=fr_FR): aggregate group receipts and per-message information.
- [WhatsApp privacy](https://www.whatsapp.com/privacyquestions): end-to-end encryption for personal messages and media.
- [WhatsApp groups](https://www.whatsapp.com/groups): group messaging, events, and calling.

## Progress log

| Date       | Phase / issue | Work completed                                                        | Verification / remaining work                                               |
| ---------- | ------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 2026-10-22 | Tracker       | Converted the supplied assessment into prioritized, trackable issues. | No remediation or new verification performed as part of creating this file. |
| 2026-10-22 | 1.1–1.5 | Added acknowledged cluster eviction, race-safe membership checks, atomic presence/typing cleanup, immediate client invalidation, shared chat/info subscriptions, and durable revocable sessions with idle token expiry. Fixed Redis v4 key scanning. | Backend unit checks: 36 passed; client checks: 44 passed; database suite: 211 passed (including 7 two-server security checks); desktop/mobile Playwright: 4 passed; client build passed. Migration 032 applied locally; deployment and fresh sign-in remain rollout steps. No commits made. |
| 2026-10-22 | 2.1–2.4 | Separated connectivity, foreground viewing, typing, offline and unknown states; added visibility/resume heartbeats, per-device leases, atomic expiry and index repair, reconnect recovery, and drained shutdown cleanup. Info pages no longer call read pointers last-seen presence. Message alerts are suppressed only for a live foreground subscriber. | Backend unit checks: 36 passed; client checks: 47 passed; PostgreSQL/Redis suite: 218 passed, including 14 realtime access/presence checks; desktop/mobile fixture-based Playwright: 8 passed; client build passed. Remaining Phase 2 items stay open. No commits made. |
| 2026-10-22 | 2.5–2.9 | Added client typing throttling and shared server rate limits, expiry for initial/live activity, lifecycle cleanup, device aggregation, recording indicators, symmetric block filtering, and room activity versions to reject delayed snapshots. Microphone cleanup covers backgrounding, late permission results, device loss and recorder errors. | Backend unit checks: 37 passed; client checks: 52 passed; sequential PostgreSQL/Redis suite: 216 passed, 0 failed, 6 R2-dependent checks skipped; separate two-server realtime suite: 18 passed; desktop/mobile fixture-based Playwright: 20 passed; production client build and whitespace checks passed. Initial live-R2 checks hit external DNS failure; the first concurrent run also hit a socket timeout, then targeted and sequential reruns passed. Fixed the forwarding test to mock its storage signer consistently without live credentials. No new migration/environment variables or commits. Items 2.10–2.14 remain open. |
| 2026-10-22 | 2.10–2.14 | Added foreground viewport-only reads, resume/reconnect rechecks, exact-message acknowledgements and contiguous unread pointers, immutable send-time recipients, all-recipient group ticks, sender-only Message info, first-ack timestamps, monotonic summary updates, and historical-view receipt recovery. Membership changes preserve the original audience; legacy history is explicitly incomplete. | Backend unit checks: 37 passed; client checks: 58 passed; PostgreSQL/Redis suite: 220 passed, 0 failed, 6 R2-dependent checks skipped; final two-server realtime suite: 22 passed; desktop/mobile fixture-based Playwright: 26 passed; production build and whitespace checks passed. Migration 033 applied locally. API contracts and rollout documentation updated. Phase 2 is complete; production rollout requires migration 033 before API/client deployment. No commits made. |

| 2026-10-22 | 3.1–3.6, 4.1–4.5 | Added a transactional change journal with committed cursor allocation, durable delivery recovery, authorized versioned snapshots, reconnect/foreground/polling reconciliation, tombstone and pending-draft protection, session-bound browser push with scoped renewal, permission/opt-out controls, preference/block/presence enforcement, and authoritative notification counts. | Backend unit checks: 39 passed; client checks: 68 passed; PostgreSQL/Redis suite: 226 passed, 0 failed, 6 live R2 checks skipped; desktop/mobile Playwright: 36 passed; production build and whitespace checks passed. Migrations 034–035 applied locally and rerun safely. Fixed stale removal fixtures to reflect server membership. Push provider and closed-app delivery are mocked; real VAPID contact/key configuration and deployed device acceptance remain open for Phase 4. See docs/SYNC_AND_PUSH.md. No commits made. |
