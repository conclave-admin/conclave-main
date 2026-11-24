# Controlled beta readiness

Assessment date: **24 November 2026 (Africa/Lagos)**.

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

- [ ] Preserve room creation for owner, admin and member roles. Verify that the
  creator becomes room admin without gaining wider team administration.
- [ ] Restrict team project creation to owner/admin at the API, service and UI
  layers. Members must not see an enabled creation control and direct API calls
  must return `403`.
- [ ] Document the owner/admin/member matrix for settings, invites, requests,
  roles, rooms, projects, discovery, archive and transfers.
- [ ] Preserve the single-owner database invariant and require ownership
  transfer before the owner can leave or be removed.

### Required lifecycle evidence

- [ ] Add database coverage for team creation idempotency and ordinary member
  room creation.
- [ ] Cover email-bound invitation acceptance by a verified user, rejection for
  an unverified or mismatched user, expiry, revocation, maximum uses and
  concurrent acceptance. Repeated acceptance must not consume another use.
- [ ] Cover shareable invitations and join-request decisions without widening
  access to unrelated rooms.
- [ ] Cover ownership transfer: old-owner demotion, new-owner administration in
  every team room, history boundary and the single-owner invariant under races.
- [ ] Cover member removal and self-leave, including HTTP/socket revocation,
  pending-task cleanup, invite cleanup and loss of project access.
- [ ] Cover archive/restore as read-only behavior across messages, tasks,
  decisions, projects, briefs and automations.
- [ ] Keep team names non-unique and document that IDs identify teams. Add a
  stable slug or visible disambiguator before duplicate names cause confusion.
- [ ] Set a beta cohort cap per team and document owner recovery/support.

## P0 — projects and connected work fit for beta

### Creation and naming rules

- [ ] Require owner/admin team membership for project creation in both
  `/teams/:teamId/projects` and `/work/projects`. Eliminate policy differences
  between these entry points.
- [ ] Require 1–20 distinct initial rooms. Every room must belong to the same
  team, the creator must have required room administration rights, and the team
  must be active.
- [ ] Remove or disable the current empty-project path in the team page. Guide an
  owner/admin to select at least one eligible team room.
- [ ] Add case-insensitive project-name uniqueness scoped to `team_id` and
  return a specific `409`. Decide a corresponding scope for retained personal
  projects before applying the migration.
- [ ] Define project management as project creator, team owner or team admin so
  an admin can operate a project created by another authorized administrator.
  Apply the same rule to milestones, rooms, briefs and automations.

### Required lifecycle evidence

- [ ] Cover creation, initial room linking, room add/remove, cross-team
  rejection, duplicate room assignment, archived-team rejection and status.
- [ ] Cover visibility: non-members see nothing; eligible members see only
  projects and linked rooms allowed by policy; removal immediately removes access.
- [ ] Cover milestones, task assignment, dependency cycle prevention, dependency
  cleanup on room removal and decision/task summaries.
- [ ] Cover brief optimistic concurrency and source-message visibility.
- [ ] Cover automation idempotency across competing workers and failure/retry.
- [ ] Surface API truncation at 200 tasks or 50 decisions; add pagination before
  the beta cohort can realistically reach those limits.
- [ ] Cover work inbox and search after history clearing, deletion, room leave
  and team removal.
- [ ] Leave `teams.avatar_url` unwired only if no team-avatar control is shown.
  Track avatar upload as polish rather than implying it works.

## P0 — moderation and enforcement

- [ ] Add server-enforced platform-role middleware. Ordinary users and room
  admins must never gain platform report access.
- [ ] Add an explicit provisioning script for granting/revoking the existing
  moderator role; do not expose unaudited public role management.
- [ ] Add a paginated/filterable moderator report inbox with bounded context.
  Reporter identity should remain hidden until operationally necessary.
- [ ] Add concurrency-safe `open`, `reviewed`, `actioned` and `dismissed`
  transitions with actor, reason, timestamps and an append-only audit table.
- [ ] Add account suspension/restoration. Suspension must block login and API
  access and revoke all sessions immediately.
- [ ] Add authorization/privacy tests: users denied, room admins denied, revoked
  sessions denied and unrelated room/message context withheld.
- [ ] Assignment can remain deferred for a single-moderator beta. Appeals may be
  intake-only; full appeals and content-removal enforcement can follow.

## P0 — deployment, media and candidate verification

- [ ] Make allowed client origins configurable as a validated list. The current
  exact `CLIENT_ORIGIN` cannot serve separate beta/staging origins and has
  caused browser-suite CORS failures.
- [ ] Complete the approved media path: streaming wiring, preview Worker width
  support and CI, medium viewer step, gallery work and live Worker deployment.
- [ ] Set beta storage caps or, at minimum, cohort limits plus storage/spend
  alarms and an operator response threshold.
- [ ] Run with Node 22 as declared by the repository and CI.
- [ ] Run `npm run check`, fresh/rerun migrations, the complete database suite,
  browser/security suites and media suites against the final candidate.
- [ ] Apply migrations through 065 twice in staging and verify the constraints.
  No production migration is included without a separate deployment decision.
- [ ] Complete live R2, push and Resend acceptance with beta credentials.
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

## Deferred features and the beta boundary

The following items from `DEFERRED_FEATURES.md` may remain deferred when their
limitations are disclosed:

- OS notification actions.
- Recurring quiet hours.
- Voice/video/group calling and call history.
- Room events.

Cross-room search is no longer wholly absent: scoped work search covers visible
messages, decisions, tasks, files, rooms and shared people. Broader ranking,
filters, scale and product semantics may remain deferred, but documentation must
not describe all cross-room search as unimplemented.

The following deferred items require an explicit beta control:

- **Platform moderation:** the minimum inbox, audit and suspension workflow above
  is required because reports are already exposed in the product.
- **Storage quotas:** reservation accounting may trail beta only with cohort
  caps, alarms and an operator response threshold.
- **Malware scanning:** may remain deferred only for a trusted small cohort with
  documented risk acceptance, strict file controls and a rapid takedown path.
  It becomes a public-launch requirement as the population opens.

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
