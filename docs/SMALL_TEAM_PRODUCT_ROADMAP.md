# Conclave small-team product roadmap

**Audience:** Small teams that coordinate through conversation and need decisions and commitments to stay visible.  
**Strategy:** Integrate with existing tools now; earn the ability to replace more of them over time.  
**Status:** Product plan, not an implementation claim or release commitment.

## Product goal and release order

That gives Conclave a clearer order for the next release:

1. **Make messaging dependable:** focus on send and reconnect failures, notification delivery, chat loading, and recovery when the network drops.
2. **Make team setup easy:** give a small team one clear place to invite people, create rooms, and start a project.
3. **Connect Google and Microsoft calendars:** start with showing task and milestone due dates in a user’s calendar. Define how updates and cancellations sync before adding two-way editing.
4. **Then deepen project planning:** add a task board and stronger automation once the daily communication flow is dependable.

The aim is for a team to join quickly, trust that messages arrive, and see its commitments alongside its existing schedule.

Reliability is the release gate across the five product priorities below. The first three priorities should shape the next release; planning, live collaboration, and broader automation can follow in deliberate increments. A feature is ready only when its core journey works on a narrow screen, recovers from interrupted connectivity, and gives the user a clear result.

## Current foundation

The repository already contains DMs and rooms, message search and threads, voice notes and playable media, decisions and tasks, a catch-up digest, notifications, projects, milestones, task dependencies, room briefs, and two project automation rules. These are a useful starting point, not evidence that every path is reliable in production. The project model is separate from an organization or workspace model: room membership currently determines access. Calendar connections and live calls are not implemented in the inspected application code.

## Release gate: dependable daily messaging

**Outcome:** A user can send, receive, and find a message with confidence across reconnects, foreground/background changes, and temporary service failures. This matters before adding more work features because every decision and task starts in a conversation.

**Scope**

- Show an unambiguous state for each outgoing message: sending, queued offline, sent to the server, failed, and retrying. Retrying must preserve one logical message and avoid duplicates.
- Reconcile missed messages, edits, deletions, and read state after reconnect. Keep the chat list, open conversation, notification count, and digest consistent with server state.
- Make chat opening feel immediate: render the shell and recent cached messages promptly, load history incrementally, preserve scroll position, and avoid layout jumps from large media.
- Treat notifications as a delivery journey. Record whether a notification was queued, handed to a provider, and opened where observable; do not equate provider acceptance with display on a device.
- Give users a clear recovery action when upload, send, or sync fails. Offline work should remain visible instead of disappearing behind a spinner.

**Acceptance criteria**

- A message sent during a brief outage appears once after reconnection, including after a reload or second-device sync.
- Opening a long or media-heavy room does not freeze controls or shift the reading position unexpectedly.
- Muted rooms, direct mentions, active viewing, and notification preferences behave consistently across the bell, push, and digest.
- The team can inspect operational measures for send failures, reconnect recovery, chat-open latency, and notification handoff, with a baseline and a release target agreed before launch.

**Dependency:** This work can proceed immediately and is the gate for widening the product surface. Existing sync and push mechanisms should be assessed against these journeys before redesigning them.

## Priority 1: a team home and easy onboarding

> Message content is server-readable; the former message E2EE modes were removed by migration 061.

### Implementation progress (October 2026)

The first implementation pass adds team records and membership, a team home and switcher, a general room created with each team, link and email invitations, verified-email acceptance, room and project creation, explicit legacy transfer previews, owner transfer, member departure, archive and restore, and opt-in public team-room discovery with admin-reviewed membership requests. Team invitations use the existing encrypted email delivery queue when mail is configured. The client returns a signed-in or newly registered invitee to the invitation flow.

The implementation is **in progress**, not a release claim. Review archive behavior, reliability, narrow-screen layouts, migration, and access controls before release.

**Gap:** A small team has rooms and projects but no single place to create and manage the team itself. New users must infer how rooms, membership, projects, and invitations fit together.

**First increment**

- Introduce a team home that shows its rooms, projects, members, and pending invitations.
- Provide a short setup flow: name the team, invite colleagues, create the first room, and optionally create the first project. Each step must be skippable and resumable.
- Support invitation links or email invites with expiry and revocation. Show whether an invite is pending, accepted, expired, or revoked.
- Define team roles conservatively: owner/admin/member, with an explicit matrix for inviting members, creating rooms and projects, and changing team settings. Preserve room-level controls where they are more specific.
- Make the initial empty state useful: one clear next action, sample-free language, and links to the team's first conversation and project.

**Acceptance criteria**

- A new team can invite another person and reach a shared conversation without needing a separate explanation.
- A member can tell which team owns a room or project and what they may do there.
- Removing someone from a team revokes access to team-owned resources; personal DMs and historic records follow a separately documented policy.
- Existing users and rooms have a clear migration path, including ownership and visibility rules, before a workspace schema is introduced.
- Moving an existing room gives a newly added team owner room-admin control without revealing pre-transfer content on any server or client surface; existing room members retain their authorized history.

**Decision:** A person may belong to multiple teams at launch. The detailed design below records the agreed behavior and remaining questions.

### Priority 1 implementation plan — planning draft

This section defines the product and technical contract for a team home and onboarding. Implementation has begun as recorded above; the contract and release gates still apply. Decisions marked **agreed** came from the product discussion.

#### Agreed product rules

| Topic | Decision |
| --- | --- |
| Team creation | Any active, signed-in user may create a team. The creator becomes its owner. |
| Multiple teams | A user may belong to several teams and switch between them. |
| Invitations | Owners and admins may invite by email or shareable link. Invites expire and may be revoked. |
| Team versus room access | Team membership alone does not grant room access; room membership remains explicit. The team owner is an intentional exception and is a member/admin of every team room. |
| Existing resources | Owners choose which team receives each eligible existing room or project. Nothing moves automatically. |
| Linking a room | Every current room member must be a member of the destination team first. |
| Direct messages | DMs remain personal and cannot be linked to a team or team project. |
| Leaving/removal | Leaving or being removed from a team removes membership in that team's rooms. |
| Project boundary | A project belongs to one team and contains rooms only from that team. |
| Initial setup | Create one general room; creating a project is optional. |
| Last owner | The only owner must transfer ownership before leaving. |
| General-room access | Accepting a team invitation also joins the general room automatically. |
| Member creation rights | Ordinary team members may create team rooms. Project creation and management require the owner or admin role. |
| Admin removal | An owner or another admin may remove an admin; the owner is protected. |
| Email invitations | Acceptance requires the addressed email to be verified on the accepting account. |
| Directory email privacy | Only owners and admins see other members' email addresses. |
| Public discovery | A team admin may opt a team room into public discovery. Discovery does not grant team or room access. |
| Discovery request | An outsider may request team membership from an opted-in room preview; owner/admin approval is required. |
| Departing creators | Their projects and automation records remain; the team owner takes management responsibility. |
| Team lifecycle | The first release supports archiving, not permanent team deletion. |
| Archive behavior | Current authorized members retain read access; team-scoped messages, tasks, invites, requests, and automations pause. Owner or admin may archive and restore. |
| Departing assignees | Open tasks are unassigned when a member departs; historical attribution is retained. |
| Discovery approval | Approval also joins the applicant to the advertised room, as well as the team and general room. |
| Discovery authority | Opt-in requires both team owner/admin authority and room-admin authority. |
| Departing inviters | Their active team invitations are revoked. |
| Archived personal state | Members may still mark items read and change their own notification preferences. |
| Owner room access | The team owner is automatically a member/admin of every team room, including rooms moved into the team. |
| Ownership transfer | The new owner becomes a room admin in every team room; the former owner remains an ordinary room member wherever they were a member, retaining any independently granted admin role. |
| Transferred-room history | An owner newly added through a legacy-room transfer sees messages from the transfer point onward, not earlier history. Existing independent room access is retained. |
| Pending discovery requests | Removing a room from public discovery does not cancel existing requests; admins may still review them. |
| Former-owner room access | Ownership transfer demotes owner-derived admin roles to ordinary membership rather than removing the former owner from those rooms. |
| Admin departure | Admins leave through the normal Leave team action; the owner is the only required team role. |
| Room assignment scope | The first release assigns only unassigned legacy rooms; a team room cannot move to another team. |
| Revoked accepted invite | Revoking an invite blocks future acceptance but does not remove people who already joined. |

#### Product model and invariants

- **Team:** An organizational container with name, optional description/avatar, owner, members, invitations, rooms, and projects. A team has its own stable ID; names need not be globally unique. A team can be active or archived. The first release has no permanent team-delete action. Archived teams are readable by current authorized members but cannot accept new team-scoped content or membership changes until restored.
- **Team member:** One active user in one team with role `owner`, `admin`, or `member`. A user can have independent roles in different teams. A deleted account cannot join, accept an invite, or retain active team membership.
- **Team room:** A non-DM room assigned to exactly one team. Its room member list, admin role, approval settings, history, and digest state continue to govern access. Team membership is a necessary condition for room membership. The owner exception is implemented through an explicit room member/admin row, never by bypassing room checks. If the owner gains access only because a legacy room moves into the team, the grant begins at the transfer point. Other team members still need a separate room grant.
- **Team project:** A project assigned to exactly one team. Only rooms from that team may be linked. Existing project visibility must continue to be derived from its accessible rooms until a distinct project-membership rule is explicitly designed; otherwise team membership could accidentally expose private work.
- **Personal/legacy resources:** Existing rooms and projects remain outside teams until an eligible owner selects a destination. Personal notes and DMs always remain outside teams. Their current URLs and access rules continue to work.
- **Invariant:** No API, sync response, search result, digest item, notification, cached snapshot, or attachment URL may reveal a team room after a user's room membership has been removed. Current room-access checks remain authoritative.

#### Primary user journeys

1. **Create a team.** From a visible “Create team” action, a signed-in user enters a team name and optional description. The server creates the team, owner membership, and a general room in one transaction. On success the app opens the team home. A failed request must not leave a half-created team or duplicate general room after retry.
2. **Invite colleagues.** Owner/admin chooses email invite or shareable link, sees expiry and usage limit, copies or sends the invite, and can revoke it. If mail delivery is unavailable, a copyable invitation remains usable and delivery failure is visible. A person with an account signs in before accepting; a new person registers and returns to the pending invite. Acceptance adds team membership and general-room membership atomically; other rooms remain separately granted. An email invite waits for verification of the addressed email before acceptance.
3. **Find work from the team home.** The team home shows a clear team switcher, member count, pending invites for admins, rooms the viewer can open, and projects whose linked rooms the viewer can access. Hidden rooms and inaccessible project details must not leak through counts or search. Empty states point to the next action.
4. **Create a room or project.** Authorized members create a team room from the team home; its creator is room admin. A project may be created after or instead of further rooms. The project picker offers only rooms in that team for which the actor has authority to link.
5. **Move existing work deliberately.** An eligible owner selects an unassigned non-DM room or project, sees a preflight list of blockers, and confirms the move. Blockers include members outside the destination team, cross-team project links, and insufficient authority. The preview explicitly states that the team owner will become a room member/admin but, if newly added, will see only messages from the transfer point onward. The server rechecks all conditions in the transaction before assigning `team_id` and inserting/promoting the owner room membership with an immutable visibility boundary. An owner who was already a room member retains their independently held history access. A room already assigned to a team cannot move to another team in this release.
6. **Switch teams.** Switching changes team-home context, room/project listings, navigation labels, and create flows without changing the account or clearing drafts. Deep links to rooms and projects still resolve according to authorization, even if they belong to a different team than the current switcher selection.
7. **Leave or remove a member.** Show the exact team rooms they will lose. Revoke their room memberships and related live access durably, using the existing room-removal behavior for socket eviction, sync invalidation, and personal history. Unassign open tasks and revoke active team invitations they issued. Their project and automation records remain under owner management. The only owner cannot leave or be removed until ownership is transferred. The owner remains a room admin in every team room while they hold ownership.
8. **Request access from discovery.** An outsider viewing an opted-in room can request to join its team. The request remains pending until an owner/admin approves it. Approval adds team, general-room, and advertised-room membership together; it explicitly authorizes the room join. Rejection grants no access. Duplicate requests must be idempotent.
9. **Archive a team.** An owner or admin may archive or restore a team. Current authorized members retain read access. New team-scoped messages, tasks, invitations, join requests, rooms, projects, and automation runs pause while archived. Members may still mark messages or digest items read and change personal notification preferences. Personal DMs and other teams remain usable. A restore is explicit; queued or missed automation events must not fire unexpectedly on restore.
10. **Transfer ownership.** The current owner selects an active team member and confirms the change. In one serialized operation the new owner becomes team owner and room member/admin in every team room. The former owner's owner-derived admin role becomes ordinary room membership; independently granted room-admin roles remain.

#### Information architecture and interface behavior

- Add **Team home** as a first-class destination and a compact **team switcher** near the top of navigation. “Personal” remains available for DMs, saved notes, and resources not yet moved to a team.
- The team home should have a concise header, a prominent “Invite people” action for owner/admin, “New room” and “New project” actions where allowed, and small sections for accessible rooms, projects, and members. On mobile, the same content uses one column and keeps the primary actions visible without a large management dashboard.
- The setup flow should be short and resumable: team details → general room created → invite people → optional project → finish. Success states link directly to the general room. Skipping invitations or project creation is allowed; team creation itself should not depend on email delivery.
- Clearly distinguish **team member** from **room member** in copy and UI. The team member list can show “X rooms available to you,” but must not imply that joining the team opens all rooms.
- Show member email addresses only to owners/admins. Ordinary members see display names and permitted profile details. Do not include hidden email addresses in client payloads, search responses, or analytics.
- A person who is both team owner/admin and room admin may explicitly list a room in public discovery. Nonmembers see a limited room preview and a “Request to join team and room” action. An owner/admin reviews the request in team management. Approval grants team, general-room, and advertised-room membership. Removing the room from discovery stops new requests but leaves existing pending requests available for review; the reviewer sees that the room is no longer advertised. The preview never reveals room history or private member details.
- For an invitation link, show the team name and inviter only after the server validates the token. Expired, revoked, exhausted, and already-used invites need distinct, safe messages without leaking private metadata to arbitrary token guesses.
- Existing room and project URLs should remain stable. The browser should restore a user's last selected team where possible, fall back to a valid membership, and gracefully handle a team removed while another tab is open.
- Include keyboard-accessible team switching, visible focus, readable mobile dialogs, and a reduced-motion path for any navigation transition. Invitation state must be conveyed in text, not color alone.

#### Permission matrix (agreed core, remaining details pending)

| Action | Owner | Admin | Member | Nonmember |
| --- | --- | --- | --- | --- |
| View team home and member directory | Yes | Yes | Yes | No |
| Change team name/details | Yes | Yes | No | No |
| Invite or revoke team invites | Yes | Yes | No | No |
| Promote/demote admin | Yes | No | No | No |
| Transfer ownership | Yes | No | No | No |
| Remove team member | Yes, except sole owner | Yes, except owner or self | No | No |
| Create team room | Yes | Yes | Yes | No |
| Create team project | Yes | Yes | Yes | No |
| Opt a team room into public discovery | Yes, if room admin | Yes, if room admin | No | No |
| Approve/reject team membership request | Yes | Yes | No | No |
| Archive/restore team | Yes | Yes | No | No |
| Link existing room/project to team | Yes, with resource authority | Yes, with resource authority | No | No |
| Join a team room | Only through room's existing join/invite policy | Same | Same | No |
| Leave team | Yes, unless sole owner | Yes | Yes | No |

Team roles never bypass a room's membership check to read messages, manage members, see decisions/tasks, or access attachments. The owner and approved discovery applicant gain actual `room_members` rows. For resource transfer, being a team owner/admin alone does not grant control over a room owned or administered by someone else; the existing room admin must authorize transfer, and the destination owner's new access is disclosed before confirmation. An admin may remove another admin but cannot remove the owner; concurrent removals and role changes must be serialized. An admin who wants to depart uses Leave team; no separate admin is required because the owner remains.

#### Data and API design

The implementation should use a new additive migration rather than rewriting historical migrations. Proposed tables/columns:

- `teams(id, name, description, avatar_url, created_by, created_at, updated_at, archived_at)`; team names are bounded and normalized for display but need not be unique globally.
- `team_members(team_id, user_id, role, joined_at)` with `(team_id,user_id)` primary key, role check, indexes by user and team. Enforce at least one owner through transactional service logic and concurrency-safe locking; a simple row check is insufficient.
- `team_invites(id, team_id, token_hash, email_normalized nullable, created_by, expires_at, max_uses, uses, revoked_at, created_at)`; store only a hash of the random token. Email-bound invites require an authenticated account with the same verified email. Acceptance adds team and general-room membership in one transaction.
- `team_join_requests(team_id, user_id, source_room_id, status, requested_at, reviewed_by, reviewed_at)` with one current request per user/team and server-owned provenance. Reviewing a pending request must serialize with team archive, account deletion, another review attempt, and room deletion. Discovery opt-out prevents new requests but does not cancel an existing request. Approval grants team and general-room membership atomically; the requested room is joined in the same transaction. Recheck team and room eligibility.
- Nullable `rooms.team_id` and `projects.team_id`, indexed for listing. Database guards prevent DMs/personal rooms from receiving a team ID and prevent cross-team project-room links. Migration 075 reconciles team owner grants and uses deferred database constraints to require exactly one `team_members.role='owner'` row matching `teams.owner_id`; ownership changes remain serialized service operations. Unassigned projects cannot include team rooms until moved into the team.
- Room membership needs provenance for owner-derived admin authority versus independently held roles. A separate grant-source record or equivalent must let ownership transfer demote only the former owner's owner-derived admin role to ordinary membership while preserving an independently granted admin role. Existing room member rows do not currently express this distinction.
- A per-grant history boundary is required for owner-derived access to a moved room. Store the room sequence or another immutable message boundary at the transfer transaction. Read paths must use the effective maximum of this boundary and any personal-clear boundary. A prior independent room membership must not be narrowed by the new owner grant. Messages, attachments, search, shared media/links, replies, reactions, decisions, tasks, digest, notifications, sync replay, and export-like paths must be audited for indirect disclosure of pre-transfer content. The current `message_visible` function and room-member history model do not provide this boundary automatically.
- Optional `team_events` or audit records for invitation, membership, role, transfer, and resource-link actions, with actor, target, time, and redacted metadata. Do not put raw tokens or private message content in audit rows.

Proposed endpoints (names are illustrative until API-contract review):

| Endpoint | Purpose |
| --- | --- |
| `POST /api/teams`, `GET /api/teams` | Create a team; list the caller's teams. |
| `GET /api/teams/:teamId`, `PATCH /api/teams/:teamId` | Team home data and editable details, scoped to membership. |
| `GET /api/teams/:teamId/members`, `PATCH/DELETE /api/teams/:teamId/members/:userId` | Directory, role change, and removal. |
| `POST /api/teams/:teamId/invites`, `GET /api/teams/:teamId/invites`, `DELETE /api/teams/:teamId/invites/:inviteId` | Issue, inspect, and revoke invites. |
| `POST /api/teams/invites/preview`, `POST /api/teams/invites/accept` | Token validation and idempotent acceptance. |
| `POST /api/teams/:teamId/requests`, `GET /api/teams/:teamId/requests`, `POST /api/teams/:teamId/requests/:userId/review` | Submit and review membership requests from opted-in discovery. |
| `POST /api/teams/:teamId/leave`, `POST /api/teams/:teamId/transfer-owner` | Safe departure and owner transfer. |
| `POST /api/teams/:teamId/archive`, `POST /api/teams/:teamId/restore` | Reversible team lifecycle, if the proposed archive semantics are confirmed. |
| `GET /api/teams/:teamId/transfer-preview`, `POST /api/teams/:teamId/rooms/:roomId`, `POST /api/teams/:teamId/projects/:projectId` | Preflight and explicit assignment of legacy resources. |

Every write validates the signed-in actor, active target account, current team role, resource authority, and transaction-time state. `404` should hide inaccessible team/resource IDs; `409` should explain a visible conflict such as external members, expired invite, or last-owner departure. Create and invite acceptance need retry-safe semantics. List endpoints require pagination or a deliberate bound with a cursor for teams that grow beyond the first small-team cohort.

#### Invitation and email details

- Use high-entropy opaque tokens, store SHA-256 hashes, reveal a token only at creation, and redact it from logs and analytics. Bound expiry and uses; single-use for email invitations is the likely default, while shareable links may allow limited multiple uses.
- Reuse the existing account-email delivery queue rather than sending directly during the request. A queued email must use the invitee's address and a single-purpose link. Revoke queued mail or make the token invalid when an invite is revoked.
- An email invitation should not silently create an account. Acceptance after registration must return to the same team invite and must not accept it before the user confirms their intent.
- Email-bound acceptance requires the account's verified email to match the invitation. An unverified account may preserve the pending invitation and resume after verification; a changed address must match the invitation's original address or require a new invite.
- The link preview must not reveal a team roster or private room names. Rate-limit preview and acceptance attempts by account and network source. Single-use acceptance should serialize concurrent attempts.
- Revocation prevents future acceptance only. People who accepted while the invite was valid remain members until they leave or are explicitly removed; the UI should say this when revoking an invite.

#### Migration and compatibility plan

1. Add tables and nullable team IDs without changing existing reads or writes. Preserve existing legacy rooms/projects and DMs as valid unassigned resources.
2. Introduce server authorization helpers for team membership and team-scoped creation. Keep room membership as the final access check for messages, media, decisions, tasks, digest, search, and notifications.
3. Add team creation, invitation acceptance, and a basic team home behind a controlled rollout. The existing chat and project journeys should still function for unassigned resources.
4. Add transfer preflight and explicit room/project assignment. A room can move only if all current members already belong to the destination team. The preview must disclose the owner's resulting room access. A project can move only if all linked rooms belong to that team, or a guided sequence can move the rooms first. Perform the final check under locks.
5. Add leave/removal and owner transfer after the membership and resource boundaries are enforced. Removal should invalidate active sockets and cached access; if cluster eviction fails, the server must choose a durable fail-closed/retry behavior rather than reporting false success.
6. Review old routes and queries that list rooms, projects, notifications, digest, and global search. Team context is a filter/presentation concern; it must not accidentally hide personal DMs or expose private rooms.
7. Roll out to a small cohort, observe onboarding completion and access errors, then expand. Do not force an automatic migration of legacy resources as a fallback.

#### Security and edge cases to design before coding

- **No implicit access:** Team membership never bypasses `room_members`; the owner has an explicit room member/admin grant in every team room.
- **Owner-derived roles:** Track why the owner has each room role. On ownership transfer, grant the new owner room admin everywhere and demote the old owner's owner-derived admin role to ordinary membership, preserving an independently held admin role. The former owner retains the history visible under their continuing membership and its existing boundary; ownership transfer must not reset that boundary.
- **Transferred-room history:** Newly granted owner access begins at the migration/transfer sequence. A room transfer must not expose old messages through search, attachments, decision/task source references, digest, chat previews, or sync. Do not delete or hide old messages for existing room members. The transfer confirmation must state that the owner receives future history only.
- **Removing a member:** Retain project and automation records and original attribution, revoke active invitations, and preserve history under existing deletion rules.
- **Last owner:** Owner transfer and departure must serialize so concurrent requests cannot leave zero owners. A deleted or suspended owner requires a recovery process that does not silently hand ownership to an arbitrary member.
- **Cross-team links:** Reject links that mix teams. The first release assigns only unassigned legacy rooms and projects; team-to-team room moves are not exposed. Any future move needs a separate design for memberships, history boundaries, and linked projects.
- **Invites:** Reject expired/revoked/exhausted links, deleted accounts, mismatched email-bound accounts, and replays safely. Revoking a link leaves existing accepted memberships untouched; removal is a separate explicit action.
- **Privacy:** Only owners/admins receive directory email addresses. A shareable team invite does not make the team publicly discoverable. Discovery opt-in requires both team owner/admin and room-admin authority; discovery returns a minimal preview. Approval explicitly grants room membership but must not expose earlier history beyond the room's existing history policy. Discovery opt-out blocks new requests while allowing review of requests already submitted.
- **Lifecycle:** No permanent team deletion in the first release. Archive is read-only for authorized members: team-scoped content writes, invitations, requests, and automations pause. Owner or admin may archive/restore. Personal read markers and notification preferences remain editable. Restoration resumes new writes but should not replay missed automation triggers without an explicit policy. Existing retention and personal history rules still apply.
- **Sync:** Team switcher and home must update across devices when membership changes. Losing team access should clear team-scoped cached listings and drafts only where necessary; personal DMs and unrelated teams remain available.

#### Delivery slices and review gates

| Slice | Deliverable | Review gate |
| --- | --- | --- |
| A. Contract | Final role matrix, invite policy, migration rules, API response shapes, and empty states | Product decisions below answered; access invariants documented. |
| B. Team foundation | Additive schema, membership services, team list/create/read, general-room creation | Retry-safe creation; multiple teams; no access regression for legacy rooms. |
| C. Invitations | Email and link issue/preview/accept/revoke, registration return path | Expiry, revocation, concurrency, account-state and email-binding rules verified. |
| D. Home and navigation | Team switcher, home, member directory, setup flow, mobile states | New team reaches first conversation without guidance; switcher preserves personal work. |
| E. Resource assignment | Transfer preview, explicit room/project move, cross-team guards, owner history boundary | No external member or cross-team project link survives assignment; a newly added owner cannot retrieve pre-transfer content through any path. |
| F. Lifecycle | Role changes, owner transfer, leave/removal, socket/cache invalidation | No zero-owner state; revoked users cannot read team rooms. |
| G. Rollout | Instrumentation, support playbook, limited release | Baseline and targets for completion, invite acceptance, access errors, and support reports. |

#### Success measures for Priority 1

- Time from team creation to first shared message; setup completion and abandonment by step.
- Invite creation, delivery, acceptance, expiry, and revocation rates, separated by email and link.
- Percentage of new teams with two or more active members and at least one room conversation after seven days.
- Team-switch errors, unauthorized-access attempts after removal, and support contacts about missing rooms or unclear permissions.
- Percentage of transferred legacy resources blocked by external members or cross-team links; use this to improve the guided transfer flow.

#### Planning status

The product decisions raised for Priority 1 have been answered. The owner remains a room admin in every team room, including when another room admin leaves.

Before coding, the implementation design must map the new owner-history boundary through every existing read path, define the exact API response shapes and database constraints, and review the team-create and invitation journeys against the current account-verification and room-invite flows. These are engineering design tasks under the agreed rules, not additional product decisions.

## Priority 2: Google and Microsoft calendar connections

**Gap:** Tasks and milestones have dates, but users cannot see them beside their existing schedule. Calendar is the first external connection because the target teams chose it over developer and issue-tracker integrations.

**First increment: one-way publication**

- Let each user connect Google Calendar or Microsoft Outlook Calendar using provider authorization. Ask only for the scopes needed to create and maintain Conclave events.
- Let a user choose the destination calendar and which Conclave items to publish: assigned tasks, tasks they created, and project milestones. Default to a quiet, useful subset rather than every team task.
- Publish due dates as all-day events in the user's chosen timezone. Use a stable external event ID so updates change the same event instead of creating duplicates.
- Define exact behavior for date changes, completion, reassignment, project removal, access loss, disconnect, and deletion. A removed or no-longer-visible item must not leave a misleading active event.
- Include a link back to the authorized task or milestone. Keep private details out of event titles/descriptions when the calendar may be shared; offer a generic-title option.
- Show connection health, last sync, retry state, and a manual reconnect action. Reconcile after token expiry or provider outages.

**Acceptance criteria**

- Connecting, publishing, updating, and cancelling the same item produces one correct calendar event in both providers.
- Repeated sync runs are idempotent, and a temporary provider failure retries without duplicating events.
- Disconnecting stops future writes and tells the user what happens to previously published events.
- Calendar access is per user and cannot reveal a room or project that user no longer has permission to see.

**Later:** Two-way editing and meeting scheduling. Before either, define conflict resolution, source of truth, and how a calendar edit maps to task permissions.

## Priority 3: focused project planning

**Gap:** Conclave can store projects, tasks, milestones, dependencies, and basic counts, but the work is mainly presented as lists. Small teams need to prioritize, see flow, and act on blocked or overdue work quickly.

**First increment**

- Add a project board with a small, explicit workflow: To do, In progress, Blocked, Done. Dragging or moving a card updates the same task shown in the room and personal work inbox.
- Add a prioritized backlog and a due-date calendar/list view. Keep one task record across views; do not create separate board-only work items.
- Make assignment, due date, milestone, dependency, source conversation, and decision links visible on task detail and card preview.
- Support clear filters for assignee, status, milestone, and overdue state, plus an accessible keyboard path for moving cards.
- Extend project health beyond counts only after the basics work: trend of completed versus created work, aging blocked tasks, and milestone risk. Define each metric so it cannot imply precision the data lacks.

**Acceptance criteria**

- A task created from chat appears in the board, personal work inbox, and project report without manual refresh or duplicate entry.
- Moving a task updates permissions, audit history, notifications, and digest according to one documented rule.
- A team can identify its next work, overdue items, and blockers from the project home on desktop and mobile.

**Later:** Sprints, estimates, custom fields, and advanced reports only if target teams demonstrate a need. Jira-style breadth should follow usage evidence, not precede it.

## Priority 4: live collaboration

**Gap:** Voice notes and media playback support asynchronous discussion, but there is no in-app live call or screen-sharing journey.

**First increment**

- Start with a room-level “Start call” or “Join call” entry point and an integration or hosted service that supplies audio/video and screen sharing. Keep a clear fallback when a device denies camera or microphone access.
- Make call membership follow current room access. Show who is in the call and allow joining from the conversation without losing draft or reading position.
- Decide whether calls leave an optional message in the room and whether they can be scheduled through the new calendar connection.
- Treat recording and transcription as separate later decisions with explicit consent and retention rules.

**Acceptance criteria**

- Two members can join from a room, switch devices or reconnect after a dropped connection, and return to the same conversation.
- A removed member cannot join an active call. Camera, microphone, and screen permissions fail with a usable recovery path.

**Dependency:** Do not let live calls delay dependable asynchronous messaging or the first calendar connection. A meeting-link integration may validate demand before building native calling infrastructure.

## Priority 5: broader, observable automation

**Gap:** Current project rules cover a recorded decision creating a follow-up task and an overdue task notifying its assignee. Repeated small-team handoffs still require manual work.

**First increment**

- Add templates for common journeys: decision approved → assign follow-up; task blocked → notify owner; milestone approaching → notify responsible people; new project member → send onboarding checklist.
- Add a limited rule builder with trigger, optional conditions, and one or more actions. Keep the first vocabulary small and predictable.
- Show rule owner, enabled state, last run, next eligible run where relevant, result, and failure reason. Allow safe retry of failed runs.
- Preserve idempotency and permission checks. A rule must not expose content or perform an action its configured owner could not perform directly.
- Define loop prevention, rate limits, and what happens when a rule's creator leaves the team.

**Acceptance criteria**

- A matching event produces the intended action once, including after worker restart or replay.
- A team admin can see why a rule ran or failed and can pause it without losing its history.
- Automation side effects appear in the same task, notification, and digest surfaces as manual actions.

**Dependency:** Expand only after the underlying work states and event semantics are stable. Calendar publishing is an integration, not a general automation rule in its first increment.

## Suggested delivery sequence

| Stage | User-visible result | Exit condition |
| --- | --- | --- |
| 0. Messaging reliability | Predictable send, open, reconnect, and notification journeys | Agreed reliability measures meet release targets on supported devices and networks. |
| 1. Team setup | A team can invite members and reach its first room and project | New-team journey completes without manual guidance; permissions and migration are documented. |
| 2. Calendar connection | Assigned work and milestones appear in Google or Microsoft calendars | Create, update, cancellation, retry, disconnect, and access loss behave correctly. |
| 3. Planning | One board and due-date view over existing tasks | Changes stay consistent across chat, board, inbox, and digest. |
| 4. Live collaboration | Members can quickly meet from a room | Demand and provider choice are validated; access and reconnection work. |
| 5. Automation | Common handoffs run visibly and safely | Runs are idempotent, explainable, and controllable by team admins. |

## Measures to review after release

- **Messaging trust:** send failure rate, duplicate-send rate, recovery time after reconnect, chat-open latency, and notification delivery funnel.
- **Time to value:** time from team creation to first accepted invite, first shared message, and first project task.
- **Work follow-through:** fraction of assigned tasks with an owner and due date, aging blockers, and completed follow-ups from decisions.
- **Calendar utility:** connection completion, sync failures, duplicate/stale events, and active connected users.
- **Feature adoption:** teams using the board, calls, and automation for repeated work; qualitative reasons when they do not.

Set numerical targets from a measured baseline and the devices and networks the first teams actually use. Review support reports alongside telemetry: a low aggregate failure rate can still hide a severe failure for one team.

## Decisions still open

1. Which devices and browsers define the next release's supported messaging experience, including mobile web versus a native app?
2. Can users belong to multiple teams at launch, and what happens to existing standalone rooms when the team model arrives?
3. Should the first calendar connection publish only the user's assigned tasks, or also tasks they created and project milestones by default?
4. Which calendar title/privacy default is appropriate when a user's destination calendar is shared?
5. Is a meeting-link integration sufficient to validate calls, or is native in-app calling essential to the first live-collaboration increment?

## Reference points

- [Slack huddles](https://slack.com/help/articles/4402059015315-Use-huddles-in-Slack) illustrate quick live conversation and screen sharing from a channel.
- [Slack Workflow Builder and connectors](https://slack.com/help/articles/360035692513-Guide-to-Slack-Workflow-Builder) illustrate connected workflows across services.
- [Jira sprints](https://support.atlassian.com/jira-software-cloud/docs/enable-sprints/) and [reports](https://support.atlassian.com/jira-software-cloud/docs/generate-a-report/) illustrate deeper planning and progress analysis; Conclave should add only the parts small teams need.
- [Trello automation](https://support.atlassian.com/trello/docs/automation-overview/) illustrates event, schedule, due-date, and button triggers.
