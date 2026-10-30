# Privacy, account recovery, and device encryption

Phase 5 was implemented on 23 October 2026. Sections through **Collaboration and
moderation** describe the current implementation and its limits. **Planned
encryption upgrade** records product decisions and open design work; none of that
section is implemented. Functional tests are not an independent cryptographic
audit. Do not advertise audited encryption, Signal compatibility, forward
secrecy, or WhatsApp security parity for the current implementation.

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

## Planned encryption upgrade — decisions and design work

**Status: planning only.** This is the agreed target for the next encryption
design, not a description of deployed behavior. The [small-team roadmap](SMALL_TEAM_PRODUCT_ROADMAP.md)
tracks how it affects team onboarding. The existing `conclave-e2ee-v1` timeline
and all real user history must remain readable. Do not rewrite or discard old
ciphertext, keys, backups, or room references. Earlier server-readable history
cannot be made retroactively secret by upgrading future messages.

### Agreed target

| Area | Product decision |
| --- | --- |
| Coverage | Encrypt every conversation type, including DMs, private rooms, public rooms, and team rooms. Public discovery may reveal only deliberately public room metadata, never history or keys. |
| Platforms | Desktop and mobile **browsers** are required. Native mobile encryption is outside this upgrade. |
| Security | Only authorized conversation devices read content. Require forward secrecy, post-compromise recovery, message authentication/integrity, verifiable identity, and a design assessment of deniability. Security recovery is conditional on fresh key updates, correct key deletion, and uncompromised client software. |
| Protocol direction | Evaluate Signal Protocol for DMs and MLS for group rooms, using each where strongest. No browser library or wire format has been selected. |
| Existing history | Preserve `e2ee-v1` history. Any replacement must have an explicit migration boundary and keep the old timeline readable to its previously authorized readers. |
| Search and catch-up | Build search and rule-based catch-up on each authorized user's device from decrypted content. The server must not receive plaintext queries, message bodies, or generated summaries. |
| Tasks and decisions | In encrypted rooms, titles, descriptions, and status are encrypted. Authorized devices render work views from decrypted data. Server workflow must not require these plaintext fields. |
| Release claim | An independent external security review is required before calling the upgrade production-ready or WhatsApp-grade. If a maintained, audited browser-compatible Signal implementation is not suitable, pause the release decision and assess options before building a wrapper. |

“WhatsApp-grade” is a goal expressed as security guarantees, not a cipher name or
an implementation label. Signal's Double Ratchet derives a new message key for
each message and mixes in fresh Diffie–Hellman material for recovery after a
past compromise. MLS uses group epochs and membership commits; its forward
secrecy and post-compromise security depend on clients processing updates and
deleting old keys. Neither protocol protects against malicious code served by
the web origin, a compromised browser/device, or retained plaintext copies.
MLS authentication also must not be described as automatically providing the
same deniability properties as a pairwise Signal conversation. [Signal Double
Ratchet](https://signal.org/docs/specifications/doubleratchet/) · [MLS
RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)

### Privacy boundary for collaboration features

The server may authenticate, authorize, store, relay, and paginate ciphertext.
It may use explicitly approved metadata, but it cannot inspect encrypted
messages or work fields to build search results, summaries, previews, task
boards, or automation. Local search and catch-up need a defined encrypted
history fetch and indexing strategy so a fresh or restored browser can rebuild
them. A result must link back to the authorized message, task, or decision.
Cross-device read state and counts need a consistent sync contract that does
not expose content.

Server-driven assignment reminders, due-date alerts, task counts, project
automation, and Google/Microsoft calendar publication cannot simply reuse the
current plaintext work model. Each requires an explicit choice of permitted
server metadata or user-device processing. Calendar publication also discloses
whatever fields are sent to the connected provider; the user must understand
that boundary before enabling it. These details remain **undecided**. In
particular, whether the server may see assignee IDs, due dates, and completion
state has not been settled. Do not treat “encrypted task” as compatible with
plaintext status storage without a further product decision.

### Membership, history, and migration rules

Adding a person to a team does not grant room history. A room grant and its
cryptographic membership transition are separate steps. When a legacy room
moves into a team, a newly added team owner becomes room admin but starts
content visibility at the transfer boundary; existing members retain their
previously authorized history. For an encrypted room move, the owner must have
an approved device first. A later transfer of team ownership may proceed while
the incoming owner lacks an approved device, but encrypted content access must
wait for enrollment and key delivery. Never backfill earlier room keys to a
newly admitted owner merely because their role changed.

When a team member leaves or is removed, their devices must be excluded from
future group epochs or pairwise sessions before new messages are accepted under
the changed roster. Already downloaded messages cannot be recalled. An
approved applicant without a ready device may join the team and general room
while encrypted advertised-room access remains visibly pending; that grant is
invalidated if membership or room eligibility ends. Public room listing is
discovery, not cryptographic admission. Archived teams remain readable to
authorized devices, while sends and shared mutations stop; personal read state
may still change.

Legacy `none` rooms need an explicit transition to an encrypted new-message
timeline, with clear treatment of older server-readable messages and files.
The current migration path only supports `none` to `e2ee-v1` for eligible
conversation types. The database currently constrains `encryption_mode` to
`none` or `e2ee-v1`; a v2 mode requires an additive schema migration. The
upgrade also affects device certificates, prekey or KeyPackage distribution,
delivery ordering, offline replay, group commits, local storage, backup,
restore, and identity verification. Changing only the client crypto modules
would be insufficient.

### Decisions still needed before implementation

- Define exactly which metadata the server may retain for encrypted tasks,
  reminders, counts, calendar sync, and moderation; define provider disclosure
  and generic-title behavior for connected calendars.
- Decide whether local search/digest indexes or work projections sync between
  devices as user-encrypted data, and how a new browser rebuilds them after
  device approval or backup restore. Specify behavior when local keys are lost.
- Choose browser-compatible protocol libraries only after a threat model,
  maintenance/license review, desktop/mobile browser prototype, and external
  review plan. The official [libsignal repository](https://github.com/signalapp/libsignal)
  currently documents native Node bindings; [OpenMLS](https://github.com/openmls/openmls)
  exposes a WASM path that needs suitability testing in this application.
- Specify asynchronous device enrollment, identity-change warnings, skipped or
  out-of-order messages, group commit ordering, member removal during an
  offline send, and recovery after partial delivery.
- Design backup and restore for ratchet and group state without reintroducing
  old keys in a way that defeats forward secrecy. Define what historic content
  remains recoverable and what a new device may legitimately read.
- Commission independent security review and resolve findings before a
  production-ready or WhatsApp-grade claim.

### Browser-device protection plan — WhatsApp-inspired, not yet implemented

WhatsApp's multi-device design gives each linked device an identity, allows
independent delivery, and transfers an encrypted recent-history bundle to a
newly linked device. Its web app offers an optional timed app lock. Conclave
should adapt these *product behaviors* to a browser-first design, without
assuming a web browser has the same secure storage as a native phone app.
[WhatsApp multi-device design](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/) ·
[WhatsApp Web app lock](https://faq.whatsapp.com/1726618467788240/?cms_platform=web)

**Threat model and boundaries.** Protect against someone opening an unattended
browser profile, copying its IndexedDB files, stealing a server backup, or
trying to link an unapproved device. A local lock is more than an overlay: when
locked, the app must discard in-memory vault keys and plaintext views, stop
decryption, hide notification content, and require a cryptographic unlock before
reading the encrypted local vault. It cannot protect against malicious code
served by Conclave's own origin, a hostile browser extension, an unlocked
device, screenshots, or data already copied before revocation. Device disk
encryption and a strong OS account remain valuable but cannot be assumed or
verified by the web app.

**Device identity and approval.** Every browser installation has its own
device identity and independent protocol state. Creating a normal account
session must not silently approve a new encryption device. A previously
approved device authenticates the link request after showing matching device
codes or a QR challenge; a backup/recovery path is separate and visibly marked.
Show device name, browser, approximate last use, approval method, and revocation
state in settings. Warn when a participant's identity or device roster changes;
do not let a server-added device silently receive keys. Enrollment expires and
is idempotent across lost responses. A new browser receives only the history
its account was authorized to see, through a defined encrypted history-transfer
or backup mechanism; membership changes never grant older room history.

**Local vault.** Store protocol secrets, identity material, ratchet/MLS state,
and any history-recovery keys in a versioned authenticated-encryption envelope
in IndexedDB. Derive or obtain the local wrapping key only during unlock. Keep
the wrapping key in memory for the unlocked period; never put it in localStorage,
the server session, analytics, or an unencrypted IndexedDB row. A strong local
passphrase protected with a memory-hard KDF such as Argon2id is the baseline
candidate. Store the KDF algorithm, salt, and cost parameters with the envelope
and benchmark them on supported low-memory mobile browsers. A passkey-based
unlock may be offered only where the browser and authenticator support a
suitable WebAuthn PRF, require user verification, and have defined fallback and
recovery behavior. Ordinary WebAuthn login or a non-extractable `CryptoKey`
alone must not be presented as encryption of the vault. In particular, a
non-extractable key persisted in the same browser profile is not a proven
defense against copying that whole profile; it only prevents normal API export
of its raw key bytes. [WebAuthn PRF](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions#prf) ·
[Libsodium password hashing](https://doc.libsodium.org/password_hashing/default_phf) ·
[CryptoKey extractability](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey/extractable)

**Plaintext and cache policy.** Inventory every place plaintext can persist:
message cache, downloaded media, drafts/outbox, thumbnails, search index,
catch-up index, task/decision projections, browser notifications, and service
worker storage. Encrypt persistent copies with a key derived from the local
vault or omit them. On lock, clear plaintext from app state and DOM; on logout,
clear plaintext caches and authentication tokens while retaining only the
encrypted vault if this is the chosen account policy. On account deletion or
explicit “forget this device,” delete the local vault and caches. Browser and
OS storage can retain recoverable remnants, so local deletion is a best-effort
operation, not a remote wipe guarantee.

**Concurrency and failure behavior.** Serialize vault and protocol-state writes
across tabs; encrypt a message and persist the advanced ratchet state and
outbox record atomically enough that a crash cannot reuse a message key or
duplicate a logical send. Lock all tabs together, including workers, and
invalidate stale in-flight decrypts. If storage is unavailable, corrupted, or
evicted, stop encrypted sends and offer approved-device transfer or backup
restore. Do not silently create a fresh identity for an existing account.
The UX must distinguish “locked,” “device not approved,” “keys missing,” and
“connection unavailable.”

**Backup and recovery.** Continue to make cloud backup ciphertext-only to the
server, but version it for v1 and v2 material. Define whether backup contains
current protocol state, a separately protected history-export key, or both.
Restoring old ratchet state can undermine forward secrecy or cause state reuse;
this needs protocol-specific review. An approved-device history transfer and a
recovery-key restore must show exactly which conversations and dates become
readable on the new browser. If every approved device and recovery secret are
lost, require an explicit identity reset with an unrecoverable-history warning.
An account password reset must never be treated as decryption-key recovery.

**Lost or revoked device.** Revoke its server session and future key delivery,
remove it from recipient rosters and MLS groups, rotate affected group state,
and show completion or retry status. Prevent new sends under a stale roster
while removal is incomplete. Previous plaintext and keys on that browser
cannot be recalled. A lost device that later reconnects must fail authorization
before receiving queued ciphertext or membership updates it was not entitled
to after revocation.

**Rollout sequence.** First inventory storage paths and write the threat model;
then prototype unlock and encrypted storage on the supported desktop/mobile
browsers. Migrate existing v1 IndexedDB vaults only after a successful unlock
and verified backup; preserve a recoverable rollback path without leaving a
second unprotected plaintext vault indefinitely. Next integrate approval,
cross-tab locking, history transfer, backup restore, and revocation with the
chosen Signal/MLS libraries. Finally commission external review, resolve its
findings, and deploy with an explicit migration and recovery guide.

**Agreed product behavior:** Lock the local vault after inactivity. On browser
restart, a browser explicitly marked **Remember this device** may reopen the
vault automatically; that setting requires an affirmative opt-in and a clear
warning about weaker protection if the browser profile or unlocked computer is
compromised. A browser not remembered requires a vault unlock after restart.
Account login and encryption-device approval remain separate from vault unlock:
remembering a browser never approves a new device or bypasses revocation. A
newly approved browser may receive previously authorized history through an
approved device or encrypted backup, subject to each room's original visibility
boundary. A QR or matching-code approval flow is the preferred experience.
The cloud-backup recovery key remains independent from the local app-lock
passphrase. Offer a public-computer mode that does not persist device keys or
plaintext caches after the session; such a mode may restrict offline use and
require fresh device approval next time.

**Security consequence of remembering:** Automatic reopening needs a locally
available unwrap path. It weakens protection against a person or process that
can use the browser profile; a same-profile non-extractable Web Crypto key does
not establish resistance to complete profile copying. The warning and threat
model must state this plainly. An inactivity lock must still hide content and
clear in-memory plaintext, and its unlock behavior must be specified separately
from restart reopening so the lock is meaningful.

**Product choices still open:** the non-remembered unlock method (passphrase or
supported passkey), the remembered-browser unwrap mechanism and its verified
security limits, the inactivity timeout and unlock method, whether app lock is
mandatory for every approved browser, and how much offline access remains
available while locked. Prototype these behaviors on desktop and mobile
browsers before selecting the implementation.

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
