# Team and project permissions

This matrix is the beta authorization contract. The API is authoritative; the
client hides controls that the signed-in member cannot use. A team role never
grants access to every team room. Room membership and room-admin checks continue
to protect room history, messages, briefs, tasks and decisions.

| Capability | Owner | Admin | Member |
| --- | --- | --- | --- |
| View team projects | All team projects | All team projects | Projects linked to an accessible room |
| Edit team name and description | Yes | Yes | No |
| Create/revoke invitations and review join requests | Yes | Yes | No |
| Create a private or public team room | Yes | Yes | Yes |
| Administer a newly created room | Yes | Yes | Yes; creator becomes room admin |
| Publish a public room in discovery | Yes, when also room admin | Yes, when also room admin | No |
| Create a team project | Yes | Yes | No |
| Rename, change status, attach/detach rooms, manage milestones or automations | Yes | Yes | No |
| Move eligible legacy rooms or projects into the team | Yes | Yes | No |
| Archive or restore the team | Yes | Yes | No |
| Promote or demote team members | Yes | No | No |
| Remove another member | Yes | Yes, except the owner | No |
| Transfer ownership | Yes | No | No |
| Leave the team | Transfer ownership first | Yes | Yes |

Project rules:

- A team project starts with 1–20 distinct rooms from that same team.
- The creator must be a team owner or admin and must administer every selected
  room. This prevents a project from exposing or reorganizing a room the actor
  cannot manage.
- Project names are unique within a team after trimming and case folding. Teams
  may use the same project name independently.
- Owners and admins may manage any project in their team, regardless of who
  created it. Members may read project information only through rooms they can
  access and cannot use project-management endpoints.
- A project must retain at least one attached room. Move or removal operations
  cannot create an empty team project.
- Archived teams remain readable to authorized members and reject team/project
  mutations until restored.

Team identity and recovery:

- Team names are not globally unique. The team switcher and team page show a
  stable short reference derived from the team UUID; support records use the
  full UUID.
- Controlled beta teams admit up to `BETA_MAX_TEAM_MEMBERS` users (default 25).
  Invite acceptance and join-request approval enforce the cap transactionally.
- The owner must transfer ownership before leaving, being removed, or deleting
  their account. Each team should keep a trusted backup admin. If the owner
  cannot recover their account, the beta support operator can transfer
  ownership to an active team admin with the audited recovery command described
  in `BETA_OPERATIONS.md`.
