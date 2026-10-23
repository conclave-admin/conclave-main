# Privacy, account recovery, and device encryption

Implemented in Phase 5 (23 October 2026). This document describes actual scope,
including limits. Functional tests are not an independent cryptographic audit.
Do not advertise audited encryption, Signal compatibility, forward secrecy, or
WhatsApp security parity.

## Conversation scope and migration

| Conversation              | New conversations             | Existing history                               |
| ------------------------- | ----------------------------- | ---------------------------------------------- |
| DM (`dm`)                 | Device encrypted, `e2ee-v1`   | Remains server readable until an explicit move |
| Private room (`private`)  | Device encrypted, `e2ee-v1`   | Remains server readable until an explicit move |
| Public, group, department | Server readable collaboration | Unchanged                                      |

A room with type `group` or `department` is a collaboration room; it does not
become encrypted just because membership is restricted. The info page displays
the actual mode. Public rooms cannot use the encrypted migration action.

Moving a legacy conversation creates a separate encrypted timeline, copies its
members, and makes the old timeline read only for new sends. It does not encrypt
old database rows, backups, already downloaded files, or exports. Every member
must have an approved encryption device before the move. Deploy the updated API
and client together after migrations 036 and 037; old clients cannot send into
new encrypted conversations.

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
and revokes all sessions and their encryption devices. Atomic login issuance
checks the password hash under an account lock to reject a concurrently outdated
login. Resetting a password does **not** recover encrypted history. The separate
encryption recovery key or an already approved device is required.

## Sessions and remote logout

Settings lists active sessions, device names, user agents, expiry, and coarse
last activity, and lets the owner rename the current session or revoke one/all
other sessions after password confirmation. Revocation updates durable session
and refresh records, revokes bound encryption devices, and evicts sockets across
Redis-connected API instances. A durable private session invalidation also retries
eviction if immediate cluster delivery fails. An eviction failure may return
503 even though durable revocation has already committed; the client must not
interpret that response as restoring the session.

Expiry, REST checks, socket checks, and sync recovery all enforce the persisted
revocation. No system can erase plaintext, keys, or files already copied onto a
revoked device. Account deletion also removes cloud key backups and outstanding
mail tokens; the deleting browser removes its local encryption vault.

## Encryption protocol and trust model

`conclave-e2ee-v1` is a custom signed envelope built with libsodium primitives.
It is not the Signal protocol or MLS and has not received an independent audit.

- Each account has an Ed25519 identity. Approved devices hold its private key and
  have their own X25519 box key and Ed25519 signing key. The identity signs a
  certificate binding account, device ID, and both public keys.
- Every message uses a fresh 256-bit symmetric key and 24-byte nonce with
  XChaCha20-Poly1305. Authenticated context binds scheme, room, client ID,
  sender, and edit revision. The key is sealed separately to every current
  approved recipient device. The device signs the canonical ciphertext envelope.
- The server checks current membership, active sessions, device certificates,
  signature, revision, and exact recipient coverage. The browser checks context,
  signature, certificates, and pinned identity before accepting plaintext.
- Identity trust starts on first use. Conversation info shows full safety codes
  for comparison through another trusted channel. Changed identities stop sends
  until explicit verification. There is no public key transparency service.
- A new device remains pending until an approved device checks its full device
  code and sends an encrypted key bundle, or the owner restores a key backup.
  Pending enrollment expires after 15 minutes. Limits: 30 active/pending devices
  per account and 300 recipient devices per message.
- Message edits produce new signed encrypted revisions. The outbox stores a
  sealed wire payload before transmission and reuses it on a lost acknowledgement.
  Upload retries remain manual and show their failure reason.

Static device keys and retained history keys mean this design has **no forward
secrecy or post-compromise ratchet**. Sharing the account signing secret among
approved devices also makes compromise of an approved device significant. An
independent protocol review and a design for rotation/ratcheting are required
before making stronger product claims.

The service sees account IDs, memberships, timing, message and attachment counts,
file sizes, delivery/read metadata, and ciphertext. It cannot use the encrypted
body for search or previews. Transport TLS is still required. A compromised web
origin, malicious JavaScript update, browser extension, or unlocked device can
read plaintext and device keys; this protocol does not protect against those.

## Files, previews, and device storage

Encrypted conversation files are encrypted on the sender before upload with
fresh authenticated file keys. R2 receives an opaque encrypted MIME type and
`encrypted.bin`; original filename, MIME, dimensions, caption, preview, and file
key are carried inside the encrypted message. R2 previews are not used for these
files. Ciphertext is subject to the existing 50 MiB upload limit, including
encryption overhead. Download resumes ciphertext through authorized Range
requests, verifies/decrypts it locally, and stores the plaintext device cache
under a distinct representation key. The pending bubble uses the sender's
original local file.

Private keys, plaintext outbox drafts, and decrypted caches live in this browser's
IndexedDB. They are **not** protected by an OS keychain or an application
at-rest encryption password. Secure browser/OS storage and a trusted origin are
assumptions. Logout clears in-memory encryption state and normal local message/
file caches, but retains the encryption vault for future sign-in; deleting browser
site data removes that vault. Remote logout cannot erase keys on another device.
HTTPS (localhost for development), Web Locks, IndexedDB, and WebAssembly are
required. Web Locks serialize key setup across tabs; registration persists keys
before publishing them so a lost response cannot lose the identity.

## Backup and lost keys

Settings creates an encrypted cloud **key backup** and displays a random 256-bit
recovery key once. Save that key separately from Conclave. The server receives
only authenticated ciphertext, not the recovery key. This is not a password-
derived backup, a complete media archive, or a backup of files deleted from R2.
History can be recovered only while its server ciphertext and a matching archived
device key remain available. Refresh the backup after linking additional devices
or changing relevant key history. Backups do not retroactively acquire future
keys or future messages sent only to other devices.

Restore requires the same signed-in account, a matching current account identity,
and the correct key; it enrolls a new device while preserving archived keys.
If all devices and the recovery key are lost, the explicit reset action starts a
new identity, deletes the old cloud backup, and revokes other sessions/devices.
Old encrypted history is permanently unavailable. Contacts must compare the new
safety code. The UI warns before this irreversible operation.

## Collaboration and moderation

| Feature                            | Encrypted conversations                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Search                             | Local decrypted cache only; no plaintext query is sent to the server. Uncached history is not searched. |
| Shared media                       | Built from locally decrypted cached messages; not a server-wide encrypted history index.                |
| Tasks, decisions, polls            | Creation disabled and rejected by the API. Use a server-readable collaboration room.                    |
| Forwarding                         | Server-side forwarding disabled for encrypted content.                                                  |
| Digests, notification previews     | Metadata/placeholders only; no server-generated plaintext summary.                                      |
| Replies, receipts, reactions, pins | Existing metadata paths remain; encrypted bodies are opened on authorized devices.                      |
| Reports                            | User explicitly types report details; decrypted messages/files are not automatically attached.          |

## Verification and rollout

Automated checks cover real PostgreSQL/Redis multi-instance privacy, requests,
remote revocation, token expiry/single use, encrypted mail queue retry, encrypted
message validation, device linking, encrypted backups, and legacy migration.
Desktop/mobile Playwright uses real API/socket/crypto and mocked R2 storage to
exercise encrypted text/files, offline queue/reload, downloaded plaintext, backup
restore, lost enrollment responses, and multiple tabs. Mocked storage does not
prove production R2 behavior; mocked email delivery does not prove Resend delivery.

Before public security claims: configure and verify Resend delivery, deploy on
HTTPS, exercise real R2/Worker deployment and browser/device combinations,
commission independent protocol/security review, and assess key storage,
rotation, forward secrecy, recovery UX, and abuse operations. Keep these rollout
requirements open in `issue.md`.

Primitive references: [libsodium authenticated encryption](https://doc.libsodium.org/secret-key_cryptography/encrypted-messages)
and [sealed boxes](https://github.com/jedisct1/libsodium-doc/blob/master/public-key_cryptography/sealed_boxes.md).
