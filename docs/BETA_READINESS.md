# Controlled beta readiness

Assessment date: **25 November 2026 (Africa/Lagos)**.

This checklist defines the minimum gate for Conclave's small controlled beta.
Registration remains open because Conclave supports direct messages and personal
rooms as well as teams. The cohort is controlled through limited distribution,
monitoring and operator support rather than an invitation-only signup gate.

This document does not replace the broader evidence in `RELEASE_EVIDENCE.md`.

## Recorded product decisions

- **Public identity:** `display_name` is the unique public identifier. Two active
  accounts cannot have the same normalized display name. No separate handle is
  introduced for this beta.
- **Registration:** open signup remains available. Shared rate limits, correct
  proxy IP handling, a server-validated honeypot and monitoring form the initial
  abuse control. CAPTCHA or an allowlist is a follow-up if abuse appears.
- **Team rooms:** any team member may create a room, matching ordinary group
  creation in messaging products. The creator becomes that room's admin and the
  team owner retains the existing owner grant.
- **Projects:** only team owners and admins may see or use project-creation
  controls. Every new project must begin with at least one attached room.
- **Names:** team names may repeat. Project names must be unambiguous within
  their team; enforce case-insensitive uniqueness within the team rather than
  global uniqueness.
- **Moderation:** a protected platform-moderator workflow and suspension
  enforcement are part of the beta floor.
- **Beta cohort:** signup remains open but is admitted up to a configurable
  active-account cap. Malware scanning remains deferred only while the URL is
  selectively distributed to personally known testers, with the documented
  takedown process available. A numeric cap does not make unknown signups
  trusted.

## Already solid — retain and regression-test

- Email is normalized to lowercase on write, registration performs a
  case-insensitive precheck, login uses a uniform unauthorized response, and
  account deletion releases the email by setting it to `NULL`.
- Passwords use bcrypt cost 12, have client/server minimum-length validation and
  a byte-length guard against bcrypt truncation. Refresh tokens rotate and are
  bound to revocable sessions.
- Team creation has an idempotency key. Invitations support expiry, maximum
  uses, revocation and optional verified-email binding. Join requests,
  ownership transfer, archive/restore and moves into teams exist.
- Projects have membership-aware visibility, status transitions, milestones,
  task dependencies, briefs and automations.
- Production rate limits use the Redis-shared path in the current working tree.
  Registration, login and report submission already have endpoint limits.

These are implementation strengths, not substitutes for final candidate tests.

## P0 — identity and signup tightening

### Unique display names

- [x] Add migration 065 with a partial, case-insensitive unique index for active
  users:
  `UNIQUE (lower(btrim(display_name))) WHERE deleted_at IS NULL`.
- [x] Before creating the index, deterministically resolve existing normalized
  collisions by appending ` #2`, ` #3`, and so on. Preserve an audit of changed
  beta/staging identities. Current local inspection found no collision, but the
  migration must be safe on other databases.
- [x] Normalize display names on registration and profile update: require a
  string, trim, collapse internal whitespace, reject control characters and cap
  the normalized value at 1–100 characters.
- [x] Reserve `Deleted user`, case-insensitively, because account deletion uses
  it as the attribution tombstone.
- [x] Catch the display-name index's PostgreSQL `23505` violation in both write
  paths and return `409` with “That display name is already taken.” Do not rely
  on a check-before-insert query for correctness.
- [x] Add database tests for case differences, whitespace normalization,
  concurrent registration, rename collisions, deleted-account reuse, the
  reserved tombstone and migration of pre-existing duplicates.

### Email identity and account verification

- [x] Add a partial database index enforcing case-insensitive email uniqueness:
  `UNIQUE (lower(email)) WHERE email IS NOT NULL`.
- [x] Catch the email index's `23505` violation during concurrent registration
  and return the existing stable `409` message.
- [x] Cap normalized email at 254 characters before the regular-expression
  check. Preserve lowercase storage and the deleted-account reuse policy.
- [x] On successful registration, enqueue the existing `verify_email` flow.
  Registration must still succeed when mail is temporarily unavailable; the UI
  should explain pending verification and offer resend.
- [x] On email-bound team invitation acceptance, turn the unverified-email gate
  into a clear verification prompt with a resend action and refresh state when
  the member returns from the verification link. Room invitations do not carry
  an email binding and therefore do not require this gate.
- [ ] Exercise live Resend verification and recovery: delivery, expiry, single
  use, retries, invalid links, password change and session revocation.

### Open-signup abuse controls

- [x] Add and document `TRUST_PROXY_HOPS` for the intended single reverse
  proxy. Deployment must set the value to the real topology rather than copying
  it blindly when more proxies are introduced.
- [x] Add an unobtrusive signup honeypot and reject populated submissions on the
  server without revealing the detection rule.
- [ ] Retain Redis-shared registration/login limits and verify their behavior
  through the deployed proxy with multiple users and addresses.
- [ ] Monitor signup volume, verification delivery failures, login failures and
  recovery abuse. Document the threshold for enabling Turnstile or an allowlist;
  CAPTCHA is not an initial beta requirement.
- [ ] Complete operator-specific privacy/terms fields and add explicit beta
  terms acknowledgement during signup.

### Identity implementation evidence — 24 November 2026

- Migration `065_unique_user_identity.sql` normalizes stored emails, allocates
  deterministic display-name suffixes, records changed display names in
  `identity_migration_065_changes`, and adds partial normalized unique indexes
  plus database checks. It refuses ambiguous historical email collisions rather
  than merging accounts.
- Registration and profile editing share `userIdentity.js`; both return
  field-specific `409` responses and retain database constraints as the final
  concurrency guard. Integration coverage includes concurrent registration,
  rename collision, deleted-account name reuse, the reserved tombstone, email
  collision, normalization and honeypot behavior.
- Configured registrations enqueue encrypted verification mail without making
  provider availability a registration dependency. Email-bound team invites
  expose resend, block acceptance while unverified, refresh on tab focus, and
  return to the pending invitation after verification.
- Registration now lands on a verification screen that names the account email,
  offers resend and status refresh, and lets a user continue while pending.
  Verification emails provide both a one-time link and an 8-digit code. A
  signed-in user can enter the code on that screen; either method consumes both
  outstanding credentials. Email-bound team invitations continue to require
  verification; this change does not add a global account lock. The user
  confirmed that Resend delivers verification mail, but live expiry and recovery
  acceptance remain open.
- Local evidence: backend unit/HTTP suite **52/52**, client unit suite **22/22**,
  client production build passed, and focused migration tests **2/2**. The full
  database invocation reached **267/271**: identity tests passed; two existing
  Redis presence recovery checks, one Redis-client lifecycle check and one live
  R2 network check failed. These remain candidate blockers and are not recorded
  as identity regressions or as a green database suite. Tests ran under local
  Node 24; the required Node 22 candidate run remains open.
- Live Resend delivery, deployed-proxy behavior, signup monitoring and hosted CI
  remain pending. No production migration or provider configuration was run.

## P0 — teams fit for beta

### Authorization policy

- [x] Preserve room creation for owner, admin and member roles. Verify that the
  creator becomes room admin without gaining wider team administration.
- [x] Restrict team project creation to owner/admin at the API, service and UI
  layers. Members must not see an enabled creation control and direct API calls
  must return `403`.
- [x] Document the owner/admin/member matrix for settings, invites, requests,
  roles, rooms, projects, discovery, archive and transfers in
  `TEAM_PROJECT_PERMISSIONS.md`.
- [ ] Preserve the single-owner database invariant and require ownership
  transfer before the owner can leave, be removed or delete their account.

### Required lifecycle evidence

- [x] Add database coverage for team creation idempotency and ordinary member
  room creation.
- [x] Cover email-bound invitation acceptance by a verified user, rejection for
  an unverified or mismatched user, expiry, revocation, maximum uses and
  concurrent acceptance. Repeated acceptance must not consume another use.
- [x] Cover shareable invitations and join-request decisions without widening
  access to unrelated rooms.
- [x] Add deferred database constraints that require exactly one `owner` team
  member matching `teams.owner_id`; reconcile prior owner/grant state safely.
- [x] Cover ownership transfer: old-owner demotion, new-owner administration
  in every team room, the history boundary and concurrent transfer races. The
  tests are authored but were not run in this pass.
- [x] Cover member removal and self-leave, including HTTP/socket revocation,
  pending-task cleanup, invite cleanup, pending-grant cleanup and loss of room
  access. The tests are authored but were not run in this pass.
- [x] Cover archive/restore as read-only behavior across messages, tasks,
  decisions, projects, briefs and automations.
- [x] Keep team names non-unique; show a stable short team-ID reference in the
  team list and detail view. The full UUID remains the authoritative identifier.
- [x] Set a configurable per-team beta cap (default 25), limit invitation uses
  to available spaces and reject acceptance/join when full.
- [x] Define owner support: recover the account first; if that fails, an
  operator verifies the request and may transfer ownership to an active team
  admin using the audited recovery script. Each beta team should have a backup
  admin before invitations are distributed.

### Team lifecycle test implementation — 24 November 2026

- The real PostgreSQL/Redis/two-server integration suite now covers concurrent
  creation-key retries, conflicting key reuse, and room creation by an ordinary
  member without changing that member's team role.
- Invitation coverage includes verified acceptance, unverified and mismatched
  rejection, expiry, revocation, maximum-use enforcement, repeat acceptance by
  the same member, and competing one-use acceptances. Repeat acceptance was
  corrected so it remains idempotent without consuming another use.
- Join-request approval grants the general room and requested public room while
  withholding unrelated private rooms; rejection grants no membership.
- Ownership transfer verifies one retained owner and owner grants across every
  team room. Removal coverage verifies immediate API denial and eviction from
  sockets connected to both server instances.
- Archive coverage asserts read-only behavior for rooms, messages, tasks,
  decisions, projects, briefs and automations, followed by successful writes
  after restoration. Brief writes now apply the archived-team guard.
- The previously open race, self-leave, cleanup and history-boundary cases are
  now authored in `realtime-access.test.js`, together with
  owner invariant, concurrent transfer and cohort-cap regressions. No lifecycle
  test was executed in this implementation pass.

### Team lifecycle guardrails — 25 November 2026

- Migration `075_team_owner_invariant.sql` repairs owner-role/grant mismatches,
  removes stale deleted-member rows, creates immutable owner-transfer audit
  records, and defers database checks until every team transaction has exactly
  one owner row matching `teams.owner_id`. Team creation and ownership transfer
  remain atomic; owner account deletion is rejected until ownership transfers.
  The migration stops with an actionable error if a soft-deleted account still
  owns a team; an operator must recover/transfer that team before retrying.
  It is authored but has not been applied to the local or staging database;
  the database invariant becomes active only after the migration is applied.
- The default beta team cap is 25 members, configurable with
  `BETA_MAX_TEAM_MEMBERS`. Shareable invitation use is capped at currently
  available spaces; invite acceptance and approved join requests serialize on
  the team row and reject new members at capacity.
- Team names remain non-unique. The UI displays a stable 12-character team ID
  reference while the full UUID remains the authoritative support identifier.
- `backend/scripts/recover-team-owner.js` supports an operator-approved
  transfer to an existing active team admin and records the operator, reason,
  previous owner and successor in append-only `team_audit_events`.
- Regression coverage is authored but was not run. Operators and named support
  contacts still need to be assigned in the release evidence.

## P0 — projects and connected work fit for beta

### Creation and naming rules

- [x] Require owner/admin team membership for project creation in both
  `/teams/:teamId/projects` and `/work/projects`. Eliminate policy differences
  between these entry points.
- [x] Require 1–20 distinct initial rooms. Every room must belong to the same
  team, the creator must have required room administration rights, and the team
  must be active.
- [x] Remove or disable the current empty-project path in the team page. Guide an
  owner/admin to select at least one eligible team room.
- [x] Add case-insensitive project-name uniqueness scoped to `team_id` and
  return a specific `409`. Retained legacy personal projects remain scoped to
  their creator and cannot be created through the beta UI or API.
- [x] Define team-project management as team owner or team admin so an admin can
  operate a project created by another authorized administrator. Apply the same
  rule to project details, status, rooms, milestones, dependencies and
  automations. Room briefs retain their separate room-admin authorization.

### Team and project authorization implementation — 24 November 2026

- Both project-creation endpoints now call the same transactional service. It
  requires an active team, owner/admin membership, 1–20 distinct non-DM team
  rooms, and room-admin access for the creator.
- Migration `066_require_team_project_room.sql` adds deferred database guards so
  a team project cannot commit without a room or lose its final room. Transfer
  previews and mutations report the same requirement, the client disables
  final-room removal, and a database trigger rejects cross-team or DM links.
- Migration `067_unique_team_project_names.sql` normalizes historical team
  project names, records changes for audit, resolves collisions
  deterministically, and adds the team-scoped case-insensitive unique index.
  Create, rename, and legacy-project transfer paths map collisions to a stable
  `409` response.
- The global projects screen is read-only for creation; owners and admins create
  projects from a team page with required room selection. Member creation and
  management controls are absent, while all team members retain room creation.
- No tests or migrations were run for this implementation batch, as requested.

### Required lifecycle evidence

- [x] Cover creation, initial room linking, room add/remove, cross-team
  rejection, duplicate room assignment, archived-team rejection and status.
- [x] Cover visibility: non-members see nothing; eligible members see only
  projects and linked rooms allowed by policy; removal immediately removes access.
- [x] Cover milestones, task assignment, dependency cycle prevention, dependency
  cleanup on room removal and decision/task summaries.
- [x] Cover brief optimistic concurrency and source-message visibility.
- [x] Cover automation idempotency across competing workers and failure/retry.
- [x] Replace project task/decision fixed result ceilings with API pagination;
  paginate the work inbox as well.
- [x] Cover work inbox and search after history clearing, deletion, room leave
  and team removal.
- [ ] Leave `teams.avatar_url` unwired only if no team-avatar control is shown.
  Track avatar upload as polish rather than implying it works.

### Project lifecycle implementation — 25 November 2026

- Creation coverage requires initial rooms and rejects duplicate selections,
  duplicate attachment, cross-team attachment and member creation. Visibility
  covers owners, administrators, members without room access, and immediate
  loss of project access after team removal.
- Milestone coverage creates, assigns and completes a milestone. Dependency
  coverage creates a blocker, rejects a cycle, and verifies that removing a
  room clears its project and milestone links plus every related dependency.
- Brief coverage races two writers at the same version and verifies one commit,
  one `409`, the winning body and the revision history. Brief source-message IDs
  are now hidden when that message is deleted or outside the viewer's retained
  history.
- Automation coverage runs competing workers for one decision event and verifies
  one durable claim and one generated task across repeated scans. A transient
  task-write failure rolls back the event claim so a later scan can retry.
- Work discovery coverage verifies assignment inbox and cross-room search,
  message deletion, task completion, history clearing, explicit room leave,
  and immediate disappearance after team membership removal.
- Project task and decision lists return 50 items per page with independent
  `taskPage` and `decisionPage` page parameters and `hasMore` metadata. Project
  health totals still aggregate every task visible to the viewer. The task
  dependency picker searches across all project pages. The work inbox now
  returns 50 items per page and the UI can load more.
- Added regression cases for pagination beyond 50 results, complete project
  summary counts, source-message visibility after history clearing, room-leave
  visibility revocation, and automation retry after a failed write.
- **Tests were authored but not run**, honoring the request to defer all test
  execution. Backend static syntax checks and the client production build passed.

## P0 — moderation and enforcement

- [x] Add server-enforced platform-role middleware. Ordinary users and room
  admins must never gain platform report access.
- [x] Add an explicit provisioning script for granting/revoking the existing
  moderator role; do not expose unaudited public role management.
- [x] Add a paginated/filterable moderator report inbox with bounded context.
  Reporter identity should remain hidden until operationally necessary.
- [x] Add concurrency-safe `open`, `reviewed`, `actioned` and `dismissed`
  transitions with actor, reason, timestamps and an append-only audit table.
- [x] Add account suspension/restoration. Suspension must block login and API
  access and revoke all sessions immediately.
- [x] Add report assignment and an audited appeal queue. Suspended users can
  submit and check appeals with their account credentials; an independent
  moderator can uphold or reverse a decision.
- [x] Author authorization/privacy regressions for ordinary users, room admins,
  bounded report context, concurrent transitions, suspended sessions, login,
  refresh and restoration. They were deliberately not executed in this pass at
  the user's request; execution is still a candidate gate.
- [ ] Add and run focused coverage for report/appeal assignment, suspension and
  report appeals, reviewer separation, credential verification, reversal and
  immediate restoration. These new paths were not tested in this pass.
- [ ] Name the moderator, support contact and storage operator; confirm who can
  perform urgent content takedown when a room admin or author cannot act.

### Private operator console at `admin.conclave.com.ng`

The frontend is deployed on Vercel and the API on Render. The implementation
serves the operator workspace from the same client build on a separately
bound Vercel domain, selected by hostname. This keeps one UI release while the
browser's origin-scoped session storage keeps public and operator sessions
separate. The hostname and an external access gate are defense-in-depth; API
roles remain the authorization authority. Public registration never grants
platform roles.

#### Repository implementation

- [x] Add exact, validated `CLIENT_ORIGINS` support to backend HTTP and
  Socket.IO CORS, retaining `CLIENT_ORIGIN` as a single-origin compatibility
  fallback. The public and operator origins must be explicitly configured in
  deployment.
- [x] Route `admin.conclave.com.ng` into a focused operator shell with sign-in,
  reports, appeals, storage overview and platform-role administration. Do not
  render the public signup flow on the operator host. Public-host moderation
  paths redirect to the operator host.
- [x] Add an admin-only API for paginated account lookup and role changes.
  Require expected-role concurrency checks and a reason, append audit entries,
  revoke affected sessions, and prevent removal/demotion of the last active
  platform administrator. Role grants require verified accounts; self-role
  changes and suspended-account changes are refused.
- [x] Add a one-time CLI path to bootstrap the first active, verified platform
  administrator. Production invocation requires matching environment, expected
  database host/port/name and an exact confirmation phrase. Once an admin
  exists, further role changes happen in the protected console. Moderator
  provisioning remains available.
- [ ] Add and run focused regression coverage for CORS origin validation,
  role-gated console access, role change authorization/audit, last-admin
  protection, bootstrap refusal after first use and immediate session
  revocation. No tests were run during this implementation.

#### Deployment and operator setup

- [ ] Bind `admin.conclave.com.ng` to the Vercel project, configure DNS/TLS
  through WhoGoHost, and verify direct navigation and deep-link fallback on
  both public and operator hostnames. Set Vercel build variables
  `VITE_OPERATOR_HOST=admin.conclave.com.ng` and
  `VITE_OPERATOR_URL=https://admin.conclave.com.ng`.
- [ ] Select and configure an identity-aware gate in front of the operator
  hostname for the founders/developers selected to operate Conclave. DNS is
  managed at WhoGoHost, so no identity-gate provider is selected here. The
  backend role check remains authoritative after the gate permits a request;
  an unlisted link or `noindex` is not access control.
- [ ] Configure the exact public and operator frontend origins in Render
  `CLIENT_ORIGINS`, then
  verify HTTP and Socket.IO CORS from each origin and rejection of an unrelated
  origin.
- [ ] Bootstrap the first active, verified platform administrator out of band
  using the guarded `platform:operator bootstrap-admin` command; then sign in
  on the operator origin, provision moderators and verify reports, appeals,
  role changes and session revocation. Role grants never appear in public
  signup. Exact usage is documented in `BETA_OPERATIONS.md`.
- [ ] Document origin-scoped browser storage: operators sign in separately on
  the admin subdomain, and both the host gate and Conclave session/role checks
  must succeed. Assign a named backup admin and support contact.

## P0 — deployment, media and candidate verification

- [x] Implement validated exact client-origin allowlists for HTTP and
  Socket.IO, covering production, staging and the admin subdomain as explicitly
  configured. Deployment values and live CORS acceptance remain pending.
- [ ] Complete the approved media path: streaming wiring, preview Worker width
  support and CI, medium viewer step, gallery work and live Worker deployment.
- [x] Add an atomic active-account signup cap, signup kill switch, storage usage
  overview, configured storage-only spend estimate, cleanup-failure alerts and
  a report command. See `BETA_OPERATIONS.md` for the daily manual billing review
  and response thresholds. These are not provider-side real-time alerts.
- [ ] Set production beta cohort thresholds, schedule the report, configure the
  provider billing alert where available, and name the operator who reviews it.
- [ ] Run with Node 22 as declared by the repository and CI.
- [ ] Run `npm run check`, fresh/rerun migrations, the complete database suite,
  browser/security suites and media suites against the final candidate.
- [ ] Apply migrations through 075 twice in staging and verify the constraints.
  No production migration is included without a separate deployment decision.
- [ ] Complete live R2, push and Resend acceptance with beta credentials.
- Calls, video calling and call history are hidden behind the default-off
  `VITE_CALLS_ENABLED` client flag and are not part of this beta release. Keep
  the implementation; do not configure TURN or count call acceptance as a beta
  gate until the feature is intentionally unveiled.
- [ ] Smoke-test supported desktop/mobile browsers and at least one Android and
  iOS device for signup, verification, invitations, rooms/projects, messaging,
  uploads, voice notes, reconnect and accessibility-critical flows.
- [ ] Complete a disposable backup restore drill and document rollback, incident
  response and account-support ownership.
- [ ] Obtain successful hosted CI for the candidate commit and link its artifacts
  from `RELEASE_EVIDENCE.md`.

## P1 — hardening during the beta window

- [ ] Add privacy-preserving metrics for signup, invite acceptance, send/upload
  failures, task completion and automation failures.
- [ ] Add bounded audit records for team ownership, roles, invitations, project
  membership and destructive changes not covered by moderation audit.
- [ ] Add user-facing support identifiers to unexpected errors without exposing
  stack traces or sensitive internal data.
- [ ] Measure socket/message load, long histories, media memory and provider
  outages at the intended beta cohort size.
- [ ] Document browser-storage eviction: automatic downloads improve offline
  access but do not guarantee permanent device storage.
- [ ] Refactor compressed `teams.routes.js` only after behavior is covered. A
  style-only rewrite during hardening adds regression risk without user benefit.
- [ ] Correct stale deployment, issue, backend-task and privacy documentation
  before publishing beta operator instructions.

## Accepted beta deferrals — not release blockers

The following capabilities remain outside the controlled beta scope. Their
absence is an accepted boundary, not a release blocker, provided the implemented
baseline behavior and authorization safeguards remain in place.

- **Voice/video calls and call history:** implemented in the codebase but
  hidden behind `VITE_CALLS_ENABLED=false`. They are not available in the beta
  UI; TURN, call push and real-device call acceptance are deferred until launch.
- **Room events:** recurring and all-day events remain deferred. One-time event
  scheduling, editing, RSVP, cancellation notices and reminders are implemented.
- **Global search:** ranking, type/room/author/date filters and paging are
  implemented. Stable cursor pagination and large-history performance remain
  beta hardening work.
- **Platform moderation:** manual report/appeal assignment and independent
  appeal review are implemented. Automated assignment, deadlines and direct
  platform-wide content removal remain deferred.

These scope decisions do not waive the beta requirements for working existing
notifications, manual DND and recurring quiet hours, voice notes, room
messaging, access-scoped search,
or the implemented moderation baseline. The detailed designs and acceptance
criteria for later work remain in `DEFERRED_FEATURES.md`.

Message push notifications now offer **Mark as read** and **Open chat** actions
where browser notification actions are supported; ordinary click-through remains
the fallback. Mark as read is bounded to the notification's visible message
sequence and requires a short-lived, single-use capability. Inline reply remains
out of scope.

Recurring quiet hours are available in notification settings. A weekly
schedule uses the account's selected time zone and suppresses push and in-app
message alerts while leaving notification history and unread state intact.

The call implementation remains in the repository, including direct and
small-group WebRTC audio/video, call controls and recent history. The beta client
keeps `VITE_CALLS_ENABLED=false`: call actions lead to a Coming soon screen,
call history is not shown, and incoming call UI is suppressed. TURN and live
call-push acceptance are intentionally deferred until calls are unveiled.

The following deferred items require an explicit beta control:

- **Platform moderation:** report assignment and appeal review are implemented.
  Their authorization, reviewer-separation and revocation checks were not run
  in this pass. Provision active moderators and name a support owner before
  beta; live operations still need a response and takedown policy.
- **Storage quotas:** reservation accounting may trail beta only with the
  active-account cap, daily storage report, provider billing review and named
  operator response described in `BETA_OPERATIONS.md`.
- **Malware scanning:** may remain deferred only for a trusted small cohort with
  selectively distributed signup, strict file controls and the documented
  takedown escalation. Open signup is still enabled, so this is an operational
  trust boundary rather than a technical allowlist. Public signup promotion or
  inability to remove harmful content is a stop condition.

## Candidate exit criteria

The beta candidate is ready when:

1. Every P0 item has dated evidence or an explicitly documented owner-approved
   limitation that does not undermine identity, authorization or moderation.
2. The final candidate commit has green hosted CI with retained artifacts.
3. Live R2, Resend and push results are linked from `RELEASE_EVIDENCE.md`.
4. The exact beta journey passes manually: register → verify email → accept a
   team invite → create a room → owner/admin creates a room-backed project →
   message and send media → report a user → moderator resolves the report →
   suspension blocks login and active sessions.
5. Rollback, backup restore, incident response and tester support owners are
   recorded.
