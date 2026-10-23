# Conclave — GitHub issue drafts

Source: `issue.md`, reviewed 23 October 2026. These are drafts for manual creation on GitHub; no remote issues have been created.

Use each **Title** as the GitHub issue title and copy its description, source, dependencies, and acceptance criteria into the body. Labels are suggestions; create or map them to your repository’s labels. Draft IDs below are local references, not GitHub issue numbers.

Completed Phase 1–3 and Phase 5 implementation items are excluded. Remaining Phase 4–5 release acceptance is included. Related open checkboxes are grouped, with source IDs retained. Where existing work overlaps an open checkbox, the draft asks for verification and demonstrated fixes rather than assuming the feature is absent. The detailed Phase 5 section takes precedence over its stale “Not started” entry in the tracker summary.

Phase 6 drafts GH-06–GH-16 are retained with completion status for tracking.
Their local implementation is complete; see `docs/ROOMS_AND_PERSONAL_HISTORY.md`
and the latest Phase 6 progress entry in `issue.md` for evidence and rollout.

## Suggested order

1. P1: verify live push/email and complete encryption security/storage/protocol reviews.
2. P2: production media, CI, physical devices, release evidence, then Phase 6 product work; use load/accessibility findings to reprioritize.
3. P3: calling, events, and additional collaboration.

## Index

| Draft | Priority | Title                                                                   | Tracker source                                                  |
| ----- | -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| GH-01 | P1       | Verify background and closed-app Web Push on deployed devices           | Phase 4: remaining acceptance check                             |
| GH-02 | P1       | Complete an independent encryption protocol and security review         | Phase 5: independent protocol/security review acceptance        |
| GH-03 | P1       | Configure Resend and verify real verification/recovery email delivery   | Phase 5: Resend email acceptance                                |
| GH-04 | P1       | Design stronger local protection for device keys and decrypted data     | Phase 5: secure local key storage review acceptance             |
| GH-05 | P1       | Design forward secrecy, key rotation, and compromise recovery           | Phase 5: ratcheting/rotation design review acceptance           |
| GH-06 | P2       | Complete the voice-note playback and recording experience               | 6.1, 6.2, 6.3                                                   |
| GH-07 | P2       | Verify receipt details and live updates across conversation info pages  | 6.4, 6.8                                                        |
| GH-08 | P2       | Add shared-link browsing to conversation information                    | 6.5                                                             |
| GH-09 | P2       | Clarify conversation notification controls                              | 6.6                                                             |
| GH-10 | P2       | Show useful conversation and device storage information                 | 6.7                                                             |
| GH-11 | P2       | Implement revocable room invitation links                               | 6.9                                                             |
| GH-12 | P2       | Add optional room join approval                                         | 6.10                                                            |
| GH-13 | P2       | Define room participant permissions and membership/history policy       | 6.11, 6.12                                                      |
| GH-14 | P2       | Provide a guided room administrator handover                            | 6.13                                                            |
| GH-15 | P2       | Audit and complete cross-device conversation preference synchronization | 6.14                                                            |
| GH-16 | P2       | Define and synchronize personal message-clearing behavior               | 6.15, 6.16                                                      |
| GH-17 | P2       | Verify deployed R2 CORS and incomplete-upload lifecycle rules           | 7.1                                                             |
| GH-18 | P2       | Verify the deployed media preview Worker and authorization              | 7.2                                                             |
| GH-19 | P2       | Run deployed real-browser media transfer and access acceptance          | 7.3; Phase 5: deployed real-R2 acceptance                       |
| GH-20 | P2       | Bound large-history rendering and media-session memory use              | 7.4, 7.5                                                        |
| GH-21 | P2       | Audit fair rate limiting across API instances and transports            | 7.6                                                             |
| GH-22 | P2       | Run sustained messaging load and network-failure scenarios              | 7.7                                                             |
| GH-23 | P2       | Add browser messaging and encryption checks to CI                       | 7.8                                                             |
| GH-24 | P2       | Complete real-device HTTPS, privacy, and encryption acceptance          | 7.9; Phase 5: deployed HTTPS and real-device/browser acceptance |
| GH-25 | P2       | Complete accessibility and reduced-motion verification                  | 7.10                                                            |
| GH-26 | P2       | Maintain a deployed release-evidence and blocker checklist              | 7.11; Phase 7 acceptance checks                                 |
| GH-27 | P2       | Complete moderation review tools and operational enforcement workflow   | 7.12, 7.13                                                      |
| GH-28 | P3       | Design and implement voice calling                                      | 8.1                                                             |
| GH-29 | P3       | Design video and group calling                                          | 8.2                                                             |
| GH-30 | P3       | Add synchronized call history and mobile/background call behavior       | 8.3                                                             |
| GH-31 | P3       | Define and implement room events and coordination                       | 8.4                                                             |
| GH-32 | P3       | Improve decisions, tasks, and digest collaboration workflows            | 8.5                                                             |

## GH-01

**Title:** Verify background and closed-app Web Push on deployed devices
**Priority:** P1
**Suggested labels:** `P1`, `notifications`, `validation`
**Tracker source:** Phase 4: remaining acceptance check

### Description

Push implementation exists, but provider and closed-app delivery have only been verified with mocks. Establish real OS/browser delivery evidence.

### Acceptance criteria

- [ ] Validate the deployed VAPID configuration and document the supported browser/device matrix.
- [ ] Exercise background and closed-app delivery, notification opening, and conversation navigation on supported platforms.
- [ ] Confirm mute, block, foreground suppression, denied permission, logout, and expired subscriptions behave correctly.
- [ ] Record results and explicit platform limitations before closing Phase 4.

## GH-02

**Title:** Complete an independent encryption protocol and security review
**Priority:** P1
**Suggested labels:** `P1`, `security`, `encryption`, `release`
**Tracker source:** Phase 5: independent protocol/security review acceptance

### Description

The custom encryption protocol has functional coverage but no independent audit. Commission review before making audited-security claims.

### Acceptance criteria

- [ ] Review identity trust, certificates, device linking/revocation, signed envelopes, attachment binding, backups, and lost-key reset.
- [ ] Include malicious-server assumptions, replay/downgrade risks, multi-device races, and browser-origin threats in the threat model.
- [ ] Track and resolve release-blocking findings; retain appropriate confidentiality for exploit details.
- [ ] Publish an accurate security/limitations statement and review sign-off.

## GH-03

**Title:** Configure Resend and verify real verification/recovery email delivery
**Priority:** P1
**Suggested labels:** `P1`, `account-security`, `email`, `deployment`
**Tracker source:** Phase 5: Resend email acceptance

### Description

The Resend API integration and encrypted mail queue exist. Actual provider/inbox delivery remains unverified.

### Acceptance criteria

- [ ] Verify the sending domain and configure RESEND_API_KEY, RESEND_FROM, APP_PUBLIC_URL, and the stable mail encryption key on the deployment.
- [ ] Receive and complete real verification and password-reset links; verify expiry and single-use behavior.
- [ ] Confirm queue retry/idempotency behavior during provider failure without logging tokens or credentials.
- [ ] Confirm reset revokes existing sessions and explains that password recovery cannot recover encryption keys.

## GH-04

**Title:** Design stronger local protection for device keys and decrypted data
**Priority:** P1
**Suggested labels:** `P1`, `security`, `encryption`, `architecture`
**Tracker source:** Phase 5: secure local key storage review acceptance

### Description

Device keys currently rely on IndexedDB and a trusted browser origin/OS. Evaluate stronger local protection without claiming a browser vault is an OS keychain.

### Acceptance criteria

- [ ] Document threats and current exposure of keys, pending drafts, and decrypted caches.
- [ ] Compare practical browser and future native key-storage options, including unlock and recovery tradeoffs.
- [ ] Record a reviewed architecture decision and implementation follow-ups with logout, remote-revocation, and account-deletion semantics.

## GH-05

**Title:** Design forward secrecy, key rotation, and compromise recovery
**Priority:** P1
**Suggested labels:** `P1`, `security`, `encryption`, `architecture`
**Tracker source:** Phase 5: ratcheting/rotation design review acceptance

### Description

The current signed-envelope protocol has no forward secrecy or post-compromise ratchet. Decide how stronger guarantees could be introduced safely.

### Acceptance criteria

- [ ] Evaluate established protocol/library options against multi-device and private-room requirements.
- [ ] Define rotation, device addition/removal, identity change, offline delivery, and backup/history behavior.
- [ ] Document a versioned migration strategy and obtain security review before implementation or stronger product claims.

## GH-06

**Title:** Complete the voice-note playback and recording experience
**Status:** Complete — local automated acceptance; real-device/live-R2 acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `voice`, `media`, `frontend`
**Tracker source:** 6.1, 6.2, 6.3

### Description

Implemented inline audio playback, speed/seeking/duration controls, explicit preview discard, recording MIME/container normalization, and cached offline playback for encrypted and server-readable conversations. See `docs/VOICE_MESSAGES.md`.

### Acceptance criteria

- [x] Provide inline playback, seeking, duration, playback speed, and accessible controls.
- [x] Allow previewing and discarding a recording before sending.
- [x] Integrate cached/offline playback and the existing recording indicators, including cleanup on interruption.
- [x] Verify encrypted and server-readable conversation behavior without exposing decrypted audio to server preview services.

### Verification

78 client assertions, 39 backend unit checks, four desktop/mobile voice cases, six recording lifecycle checks, four info/presence regression rechecks, and the production build passed. Browser checks use fake microphone capture and mocked R2. An initial signup-fixture limit and resource-contended timeouts were resolved in the fixtures/isolated reruns; no production limits were relaxed. No commit or PR was created.

## GH-07

**Title:** Verify receipt details and live updates across conversation info pages
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `conversation-info`, `synchronization`, `validation`
**Tracker source:** 6.4, 6.8

### Description

Audited sender-only receipt information and added open-dialog synchronization for privacy, membership, profile, and replay changes. Conversation information now refreshes roles and available actions. See `docs/ROOMS_AND_PERSONAL_HISTORY.md`.

### Acceptance criteria

- [x] Keep sender-only Message info discoverable and correct for DMs, groups, departed recipients, and incomplete legacy history.
- [x] Respect hidden DM read receipts without displaying private reads as confirmed unread status.
- [x] Reconcile membership, role, room, and profile changes in an already-open info page without manual reload.
- [x] Removal and role changes immediately update available actions and preserve server authorization.

## GH-08

**Title:** Add shared-link browsing to conversation information
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `conversation-info`, `search`, `frontend`
**Tracker source:** 6.5

### Description

Add a shared-links view alongside shared media, with appropriate access and encryption boundaries.

### Acceptance criteria

- [x] Provide link listing, navigation to the source message, and bounded pagination or incremental loading.
- [x] Exclude deleted, personally cleared, or unauthorized messages according to the documented history policy.
- [x] For encrypted conversations, derive links from locally decrypted data and clearly describe incomplete local coverage.

## GH-09

**Title:** Clarify conversation notification controls
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `notifications`, `conversation-info`, `ux`
**Tracker source:** 6.6

### Description

Make conversation-specific notification settings understandable and consistent with existing global preferences.

### Acceptance criteria

- [x] Show the current mute/notification state and explain its interaction with global settings.
- [x] Make the available controls accessible and understandable on desktop and mobile.
- [x] Confirm saved settings update interruption behavior and remain correct after reconnect or use on another device.

## GH-10

**Title:** Show useful conversation and device storage information
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `media`, `conversation-info`, `ux`
**Tracker source:** 6.7

### Description

Expose storage information users can act on without confusing local cached copies with server-held media.

### Acceptance criteria

- [x] Display scoped storage usage with clear device-local versus conversation/server distinctions.
- [x] Explain cache eviction/download behavior and encrypted-media limitations.
- [x] Where storage actions are offered, confirm they preserve other users’ messages and accurately update displayed usage.

## GH-11

**Title:** Implement revocable room invitation links
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `rooms`, `permissions`, `backend`
**Tracker source:** 6.9

### Description

Provide shareable invitation links whose access can be revoked by authorized room administrators.

### Acceptance criteria

- [x] Authorize link creation/revocation and define supported expiry or usage constraints.
- [x] Ensure revoked or expired links cannot grant membership, including during concurrent join/revoke requests.
- [x] Prevent membership/history leakage through invalid links and reconcile successful joins across devices.

## GH-12

**Title:** Add optional room join approval
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `rooms`, `permissions`, `frontend`
**Tracker source:** 6.10

### Description

Allow administrators to require approval before an invitation or join request grants membership.

### Acceptance criteria

- [x] Provide authorized request review, approval, and rejection with clear pending UI.
- [x] Do not expose room messages/media to pending applicants.
- [x] Handle duplicate requests, revoked invitations, and concurrent admin decisions safely.
- [x] Apply encrypted-room device readiness and history rules when approval grants access.

## GH-13

**Title:** Define room participant permissions and membership/history policy
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `rooms`, `permissions`, `architecture`
**Tracker source:** 6.11, 6.12

### Description

Define configurable participant capabilities and what history members can access before joining and after leaving or removal.

### Acceptance criteria

- [x] Document a permission matrix for admins and participants, including permission changes.
- [x] Define server-readable and encrypted-room history access, including new-device and new-member behavior.
- [x] Enforce the policy across API, realtime, synchronization, search, and media.
- [x] Verify concurrent role/membership changes and clearly disclose limits on recalling downloaded copies.

## GH-14

**Title:** Provide a guided room administrator handover
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `rooms`, `permissions`, `ux`
**Tracker source:** 6.13

### Description

Add a clear handover flow so room ownership/administration remains usable when an administrator leaves.

### Acceptance criteria

- [x] Authorize and confirm selection of an eligible successor.
- [x] Define and enforce the last-admin and simultaneous-handover rules transactionally.
- [x] Keep room roles and controls synchronized across devices after handover, leaving, or removal.

## GH-15

**Title:** Audit and complete cross-device conversation preference synchronization
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `preferences`, `synchronization`, `validation`
**Tracker source:** 6.14

### Description

Some preference synchronization is already part of the baseline and replay work. Identify actual gaps rather than duplicate those implementations.

### Acceptance criteria

- [x] Inventory account-wide and device-local conversation preferences and document their scope.
- [x] Verify two-device updates, offline/reconnect recovery, and concurrent changes.
- [x] Fix missing persistence/replay paths and ensure another account cannot inherit cached preferences.

## GH-16

**Title:** Define and synchronize personal message-clearing behavior
**Status:** Complete — local automated acceptance; deployment/physical-device acceptance remains in Phase 7
**Priority:** P2
**Suggested labels:** `P2`, `personal-history`, `synchronization`, `privacy`
**Tracker source:** 6.15, 6.16

### Description

Implemented explicitly confirmed account-wide clearing with a monotonic server boundary and a separate device-only action. Clearing survives membership rejoin, synchronizes on reconnect, filters secondary views/download access, and preserves peer history and pending sends. See `docs/ROOMS_AND_PERSONAL_HISTORY.md`.

### Acceptance criteria

- [x] Document account-wide versus device-only clearing, with matching UI labels and confirmation.
- [x] Synchronize account-wide actions across devices and reconcile them after offline periods without resurrecting cleared content.
- [x] Keep other participants’ history intact and preserve the intended behavior for replies, search, shared media, and unread counts.
- [x] Cover encrypted conversations and pending messages explicitly.

## GH-17

**Title:** Verify deployed R2 CORS and incomplete-upload lifecycle rules
**Priority:** P2
**Suggested labels:** `P2`, `media`, `infrastructure`, `deployment`
**Tracker source:** 7.1

### Description

Recheck the intended production bucket configuration rather than assume previously planned rules were applied.

### Acceptance criteria

- [ ] Validate exact allowed browser origins, required methods/headers, and exposed ETag behavior.
- [ ] Confirm incomplete multipart uploads are aborted after the intended one-day period.
- [ ] Keep direct uploads disabled until prerequisite configuration is verified; record sanitized configuration evidence.

## GH-18

**Title:** Verify the deployed media preview Worker and authorization
**Priority:** P2
**Suggested labels:** `P2`, `media`, `infrastructure`, `validation`
**Tracker source:** 7.2

### Description

Validate the actual preview Worker deployment, transformation bindings, signing, and browser behavior.

### Acceptance criteria

- [ ] Confirm Worker URL, signing configuration, bucket/transform bindings, and allowed origins.
- [ ] Check permitted previews plus expired/tampered tokens and unauthorized access.
- [ ] Confirm encrypted originals are not sent to plaintext transformation paths.
- [ ] Record deployed versions and sanitized results.

## GH-19

**Title:** Run deployed real-browser media transfer and access acceptance
**Priority:** P2
**Suggested labels:** `P2`, `media`, `validation`, `release`
**Tracker source:** 7.3; Phase 5: deployed real-R2 acceptance

### Description

Automated mocked storage checks do not establish production bucket behavior. Exercise the actual deployed frontend/API/storage path.

### Dependencies

R2 configuration and preview Worker verification; deployed HTTPS frontend/API.

### Acceptance criteria

- [ ] Verify image, video, audio, and document upload/download, including previews where supported.
- [ ] Check resumable transfers, interruption recovery, manual retry reasons, and repeated/offline local viewing.
- [ ] Check membership, blocking where applicable, removed members, deleted messages, and unclaimed-upload cleanup.
- [ ] Cover encrypted and server-readable conversations; originals and metadata follow the documented privacy model.
- [ ] Run the live R2 round trips currently skipped without credentials and record results.

## GH-20

**Title:** Bound large-history rendering and media-session memory use
**Priority:** P2
**Suggested labels:** `P2`, `performance`, `frontend`, `media`
**Tracker source:** 7.4, 7.5

### Description

Measure long conversations and media-heavy sessions, introduce virtualization where needed, and bound retained resources.

### Acceptance criteria

- [ ] Define representative large-history/media datasets and baseline memory/render/scroll measurements.
- [ ] Implement bounded rendering/caching and release unused object URLs, media resources, and listeners.
- [ ] Preserve reply/pin scrolling, brief message highlighting, receipt visibility, and historical anchors.
- [ ] Verify long messages and reply composers at narrow mobile widths without horizontal overflow.

## GH-21

**Title:** Audit fair rate limiting across API instances and transports
**Priority:** P2
**Suggested labels:** `P2`, `backend`, `reliability`, `security`
**Tracker source:** 7.6

### Description

Existing limits cover some paths. Audit consistency and fairness across REST, Socket.IO, and multiple API instances.

### Acceptance criteria

- [ ] Document limits and identity/scope for sending, activity, uploads, authentication, recovery, and other relevant actions.
- [ ] Ensure distributed limits cannot be bypassed by switching transport or instance.
- [ ] Verify actionable retry responses and outage behavior without penalizing normal multi-device use.

## GH-22

**Title:** Run sustained messaging load and network-failure scenarios
**Priority:** P2
**Suggested labels:** `P2`, `performance`, `reliability`, `validation`
**Tracker source:** 7.7

### Description

Establish measured reliability/resource targets and verify sustained behavior under load and service/network disruption.

### Acceptance criteria

- [ ] Define concurrency, throughput, latency, memory, recovery-time, and error-rate targets before evaluating results.
- [ ] Exercise realistic text/media workloads, reconnect storms, delayed/lost acknowledgements, and network interruptions.
- [ ] Include PostgreSQL, Redis, API-instance, and storage failures with authorized replay and duplicate protection checks.
- [ ] Record repeatable scenarios, observed limits, and resulting remediation issues.

## GH-23

**Title:** Add browser messaging and encryption checks to CI
**Priority:** P2
**Suggested labels:** `P2`, `ci`, `testing`, `reliability`
**Tracker source:** 7.8

### Description

CI currently runs unit/database checks and the client build. Add deterministic browser messaging coverage.

### Acceptance criteria

- [ ] Install browser prerequisites and run selected desktop/mobile messaging and recovery suites.
- [ ] Run the disposable real-API encryption suite with PostgreSQL/Redis and mocked storage/email.
- [ ] Publish failure traces/screenshots and keep live-service tests explicitly gated without leaking credentials.
- [ ] Isolate ports/databases and clean up resources; verify checks run on pull requests and pushes.

## GH-24

**Title:** Complete real-device HTTPS, privacy, and encryption acceptance
**Priority:** P2
**Suggested labels:** `P2`, `mobile`, `validation`, `release`
**Tracker source:** 7.9; Phase 5: deployed HTTPS and real-device/browser acceptance

### Description

Browser emulation is not equivalent to physical device validation. Verify the supported device/browser matrix on the deployed HTTPS app.

### Dependencies

Deployed HTTPS environment; independent security review is separately required for security claims.

### Acceptance criteria

- [ ] Document supported desktop/mobile browsers and secure-context, IndexedDB, Web Locks, and crypto requirements.
- [ ] Check mobile keyboard/composer layout, very long message replies, navigation, sleeping/backgrounding, and reconnect.
- [ ] Exercise presence, typing/recording, receipts, privacy changes, requests, blocking, and remote logout across devices.
- [ ] Exercise device linking, safety-code changes, encrypted media, backup restore, and lost-key reset with documented limitations.
- [ ] Record device/browser/OS versions and pass/fail evidence.

## GH-25

**Title:** Complete accessibility and reduced-motion verification
**Priority:** P2
**Suggested labels:** `P2`, `accessibility`, `frontend`, `validation`
**Tracker source:** 7.10

### Description

Verify core messaging and information flows with keyboard, assistive technology, and reduced-motion preferences.

### Acceptance criteria

- [ ] Check focus order/restoration, keyboard operation, accessible names, dialog behavior, and status announcements.
- [ ] Exercise screen-reader message navigation and send/upload/error states on supported platforms.
- [ ] Verify contrast, zoom/reflow, touch targets, and light/dark themes.
- [ ] Respect reduced motion for landing effects and message highlights without losing identification cues.

## GH-26

**Title:** Maintain a deployed release-evidence and blocker checklist
**Priority:** P2
**Suggested labels:** `P2`, `release`, `documentation`, `validation`
**Tracker source:** 7.11; Phase 7 acceptance checks

### Description

Consolidate actual deployment evidence and unresolved blockers so completion is not inferred from local or mocked tests.

### Acceptance criteria

- [ ] Record build/version, migrations, environment, test date, and sanitized results for each release candidate.
- [ ] Link push, Resend, encryption review, media, devices, accessibility, CI, and load outcomes.
- [ ] Document unresolved blockers and explicit release decisions; do not present mocked coverage as live-provider proof.
- [ ] Update issue.md phase status only when corresponding acceptance checks are satisfied.

## GH-27

**Title:** Complete moderation review tools and operational enforcement workflow
**Priority:** P2
**Suggested labels:** `P2`, `moderation`, `backend`, `operations`
**Tracker source:** 7.12, 7.13

### Description

Report submission exists, but review, investigation, and enforcement operations remain incomplete.

### Acceptance criteria

- [ ] Provide authorized review/triage, investigation context, decisions, and enforcement actions with auditable access.
- [ ] Handle encrypted content according to the explicit-report policy without automatic decrypted-history disclosure.
- [ ] Document operational roles, response/escalation process, retention/access rules, and action verification.
- [ ] Demonstrate a report moving from submission through review to an enforced outcome.

## GH-28

**Title:** Design and implement voice calling
**Priority:** P3
**Suggested labels:** `P3`, `calling`, `architecture`, `enhancement`
**Tracker source:** 8.1

### Description

Voice calling is a separate feature project requiring its own signaling, media, and device behavior design.

### Acceptance criteria

- [ ] Define supported call types, signaling/authentication, NAT traversal, privacy, and media security.
- [ ] Implement authorized invitation, ringing, accept/reject, audio, and hang-up behavior.
- [ ] Verify supported devices under agreed connectivity, permission, and background scenarios.

## GH-29

**Title:** Design video and group calling
**Priority:** P3
**Suggested labels:** `P3`, `calling`, `video`, `enhancement`
**Tracker source:** 8.2

### Description

Define the intended one-to-one and group video experience, architecture, and capacity before implementation.

### Dependencies

Voice calling architecture and signaling decisions.

### Acceptance criteria

- [ ] Document topology, participant limits, infrastructure requirements, access/privacy rules, and resource targets.
- [ ] Implement camera/microphone controls, participant state, joining/leaving, and error recovery.
- [ ] Verify supported devices and network scenarios, including authorization changes during calls.

## GH-30

**Title:** Add synchronized call history and mobile/background call behavior
**Priority:** P3
**Suggested labels:** `P3`, `calling`, `mobile`, `synchronization`
**Tracker source:** 8.3

### Description

Calling needs consistent history and device lifecycle behavior, not just an open in-page media connection.

### Dependencies

Calling implementation and supported platform/background scope.

### Acceptance criteria

- [ ] Define and synchronize missed, answered, declined, and ended call records across authorized devices.
- [ ] Handle incoming calls during backgrounding, multiple-device ringing, and returning to an active call.
- [ ] Enforce blocking, session/membership access, and history privacy across the call lifecycle.

## GH-31

**Title:** Define and implement room events and coordination
**Priority:** P3
**Suggested labels:** `P3`, `events`, `rooms`, `enhancement`
**Tracker source:** 8.4

### Description

Extend room coordination with a defined event model and permission/privacy behavior.

### Acceptance criteria

- [ ] Define creation/edit/cancellation permissions, attendance responses, timing/time-zone handling, and reminders.
- [ ] Synchronize event state across devices and retain relevant conversation context.
- [ ] Apply membership/privacy rules and define what is supported in encrypted versus server-readable rooms.

## GH-32

**Title:** Improve decisions, tasks, and digest collaboration workflows
**Priority:** P3
**Suggested labels:** `P3`, `collaboration`, `product`, `enhancement`
**Tracker source:** 8.5

### Description

Continue developing Conclave’s collaboration strengths with concrete, prioritized workflows.

### Acceptance criteria

- [ ] Identify and prioritize specific gaps in decisions, task ownership/status, and catch-up/digest workflows.
- [ ] Preserve conversation context and enforce permissions and notification preferences across changes.
- [ ] Respect the encrypted-room collaboration policy; define any future extension before processing encrypted content.
- [ ] Verify agreed workflows across devices and recovery/reconnect scenarios.

## Coverage notes

- Phase 4 remaining background/closed-app acceptance: GH-01.
- Phase 5 independent review: GH-02; Resend: GH-03; local storage: GH-04; ratcheting/rotation design: GH-05; deployed HTTPS/R2/devices: GH-19 and GH-24.
- Every numbered open item 6.1–6.16, 7.1–7.13, and 8.1–8.5 is referenced in the index.
- Phase 6–8 acceptance checks are included in the corresponding issue criteria, with overall release evidence in GH-26.
- Claims about outstanding work come from the tracker. This drafting task did not re-audit the code, run tests, or verify live providers.
