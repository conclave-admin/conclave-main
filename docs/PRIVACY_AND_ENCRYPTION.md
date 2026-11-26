# Privacy and account recovery

Conclave messages and attachments are server-readable and are not end-to-end encrypted. Migration 061 removes both former message-encryption modes and purges their conversations and associated data; it queues object storage cleanup. Protect transport with HTTPS.

## Privacy and blocking policy

Settings exposes independent online, last seen, photo, and about visibility:
`everyone`, `connections`, or `nobody`. Connections are users who share a room or
have an accepted/legacy DM. Pending and declined requests do not establish a DM
connection. Display names and conversation membership remain visible to authorized
members. A shared group is not hidden by blocking.

| Surface                            | Privacy/block behavior                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DM creation and send               | Unknown-user policy: everyone, requests, connections, nobody. A request permits one initial message; recipient accepts or declines. Symmetric blocks prevent new direct messages.       |
| Online, viewing, typing, recording | Per-viewer visibility; a block suppresses these indicators. Hidden online status also suppresses typing/recording indicators.                                                           |
| Last seen                          | Per-viewer policy, based on foreground activity; database timestamps are coarsened to writes at most once per minute.                                                                   |
| Profile photo and about            | Redacted in authenticated REST payloads, personalized message delivery, and photo access authorization. Previously known public legacy URLs cannot be recalled.                         |
| DM read receipts                   | Reciprocal: both users must enable receipts; blocked and pending/declined conversations hide them. Internal read pointers still support unread counts.                                  |
| Group receipts                     | Remain available to authorized members; the DM receipt switch does not conceal group reads.                                                                                             |
| Notifications                      | Blocking suppresses new direct notification delivery and browser push according to existing room policies. Already delivered OS notifications and downloaded copies cannot be recalled. |
| Shared group messages              | Membership continues to authorize group messages; blocking a member does not remove either person from a shared group.                                                                  |

Changes invalidate synchronized preferences/receipt state; presence is republished
per viewer. Blocking and DM send checks share an ordered transaction lock, so a
concurrent send cannot pass a stale block check. Membership/session controls from
Phase 1 continue to guard REST, sockets, media, and replay.

## Email verification and password recovery (Resend)

Email is sent directly through the official Resend Node SDK over HTTPS. Configure:

```dotenv
RESEND_API_KEY=<Resend API key>
RESEND_FROM="Conclave <your-address@your-verified-domain>"
APP_PUBLIC_URL=https://your-frontend-domain
MAIL_ENCRYPTION_KEY=<32 random bytes encoded as base64url>
```

Verify the sending domain in Resend and apply its DNS instructions before using
its sender address. The API key is a backend secret; never put it in a Vite
variable. See [Resend’s Node SDK](https://github.com/resend/resend-node) and [idempotent delivery](https://resend.com/changelog/idempotency-keys).
Generate the mail queue key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
Keep it stable across API instances and restarts; changing it makes pending mail
unreadable. Never log or commit these secrets. Local `.env` is ignored.

Verification and recovery use random, hashed, single-use tokens expiring after
30 minutes. Request responses are generic for eligible and unknown accounts.
Tokens are placed in the link fragment; the client removes that fragment from
browser history before submitting the token. Requests are rate limited. Password
confirmation has a separate shared per-user limiter.

Token-bearing emails are AES-256-GCM encrypted in PostgreSQL, leased by the API's
mail worker every five seconds, and retried with bounded backoff. Provider
acceptance is recorded as `accepted`, not proof of inbox delivery. Completed or
expired jobs discard encrypted payloads; expired tokens are pruned. Each attempt
uses the same job-based Resend idempotency key to suppress duplicate sends after
a lost response. Provider errors and 15-second timeouts retain bounded retries.
Mail outages do not
silently fall back to logging reset links. Unconfigured mail returns 503.

A password reset verifies control of the email address, changes the password,
and revokes all sessions. Atomic login issuance
checks the password hash under an account lock to reject a concurrently outdated
login.

## Sessions and remote logout

Settings lists active sessions, device names, user agents, expiry, and coarse
last activity, and lets the owner rename the current session or revoke one/all
other sessions after password confirmation. Revocation updates durable session
and refresh records, and evicts sockets across
Redis-connected API instances. A durable private session invalidation also retries
eviction if immediate cluster delivery fails. An eviction failure may return
503 even though durable revocation has already committed; the client must not
interpret that response as restoring the session.

Expiry, REST checks, socket checks, and sync recovery all enforce the persisted
revocation. No system can erase messages or files already copied onto a revoked device. Account deletion removes outstanding mail tokens and clears local application data.


## Files and moderation

Attachments use authenticated access and supported short-lived signed preview URLs. Previously downloaded or exported copies cannot be recalled. Reports contain the details submitted by the reporter.

Report submission is implemented, but report review and enforcement tools are
not yet available. Future review is reserved for explicitly appointed platform
moderators, with audited access and minimum necessary investigation context;
room administrators do not receive platform-wide report access. See
[deferred feature designs](DEFERRED_FEATURES.md) and
[release acceptance evidence](RELEASE_EVIDENCE.md).
