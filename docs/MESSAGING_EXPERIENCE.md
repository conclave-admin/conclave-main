# Messaging experience

## Run and deploy

Use Node 22, PostgreSQL and Redis. Apply migrations before starting the new API:

```sh
cd backend
npm run migrate
npm start
```

Migrations `040_expanded_reactions.sql` and `041_messaging_experience.sql` add
reaction validation, threads, schedules, reminders, preferences and expiry.
Existing reply quotes remain quotes; they are not silently converted into threads.

The API process runs the messaging worker every five seconds, alongside the
existing notification and storage workers. Keep at least one API process running
for schedules, reminders and physical expiry cleanup. PostgreSQL row locks,
leases, advisory locks and existing client-ID idempotency coordinate multiple
instances. Redis and the existing synchronization transport propagate updates.
No new secret or external provider is required for these features.

The browser CI job installs Chromium and runs recovery and security/experience
suites after the backend and client jobs. These checks use disposable databases
and mocked storage; they do not certify a live R2 bucket, physical devices or
production load.

## Conversation tools

- **Search:** header search queries visible server history in readable rooms.
  Encrypted conversations search decrypted history cached on the current device;
  search words stay on that device. Sender/date filters, a 50-result bound and
  source navigation are available. Searching cannot recover unavailable keys or
  history that has never reached this device.
- **Drafts:** text and reply context are saved in browser storage per account and
  conversation. Thread drafts are separate. Drafts are device-local, not a
  cross-device service. Browser storage failure leaves the in-memory composer
  usable but cannot guarantee restoration. Shared/untrusted browser profiles
  should not be used for private drafts or decrypted offline history.
- **Reading position:** the device remembers an anchor and viewport offset per
  conversation. Missing/cleared/expired anchors fall back to current history.
  Explicit message links take priority over the saved position.
- **Deletion:** deleting a chat uses an in-app confirmation and the existing
  personal clear operation. It does not delete the peer's messages or leave a
  group. Pending outbox entries remain visible according to the existing policy.
- **Threads:** message actions open persisted threads with paged history, counts,
  unread positions and a separate composer. Message activity provides a Threads
  inbox. Reading a conversation and reading a thread use separate positions;
  the panel offers “Mark displayed replies read.” Replies retain ordinary
  delivery/read receipts. New encrypted replies bind their thread root inside
  the signed encrypted body.
- **Formatting:** bold, italic, strike-through, inline code, fenced code blocks,
  copy-code and HTTP(S) links are rendered as escaped React nodes. Raw HTML is
  never executed. Link cards are explicitly expanded domain/URL previews; no
  external Open Graph page is fetched. Long text has Read more/Show less, while
  source search opens the complete body and highlights the query. Copy message
  continues to copy the full original text.
- **Emoji:** Emoji Mart is loaded when the composer or reaction picker opens.
  Composer selections are inserted at the caret. The API accepts canonical native
  emoji from the same pinned dataset, including skin tones and joined sequences;
  arbitrary reaction strings remain rejected. Apply migration 042 before the
  updated API and client to remove the old fixed database list.
- **Media status:** idle download hints are compact; progress, cancellation,
  failures, retry and offline availability remain available.

## Notifications and status

Conversation preferences offer all messages, mentions only or no interruptions,
plus one-hour, one-day, one-week and indefinite mute. Timed settings are evaluated
against their expiry, so they do not need an unmute job. Global preferences and
Do Not Disturb still apply. Changing the notification level preserves an active
mute unless a new duration is chosen.

Settings offers a 24-hour custom status and one-hour/day Do Not Disturb. Status
uses the existing About privacy boundary. Do Not Disturb suppresses interruptions,
not message synchronization. `@channel` notifies current members and `@here`
uses the existing active-in-conversation presence set. Only group admins can send
these broadcast mentions; normal member mentions remain available.

## Saved messages, schedules and reminders

Message activity collects personal bookmarks, private notes, threads, schedules
and reminders. Bookmarks reference source messages; removal, personal clearing,
expiry or lost membership makes the source unavailable. Private notes are an
individual encrypted conversation whose membership cannot be expanded.

Scheduling currently accepts **text**, including text in a thread through the
API; the main conversation composer exposes the scheduling form. Media, polls,
forwards and scheduled broadcast mentions are not supported by this form.
Dates use the device's timezone and are stored as UTC. The API accepts times
from ten seconds to one year ahead and caps active schedules at 100 per user.

For encrypted conversations the server stores a sealed payload and current
recipient/device roster, never plaintext. At send time the existing encryption
validator checks the current roster and permissions. Access/device changes stop
the schedule with **Needs your review**. Review decrypts on the device and
reseals replacement text for the current roster. Cancellation and publication
serialize; once sent, cancellation cannot recall the message. Temporary server
errors retry after one minute. Existing manual **media-upload** retry policy is
unchanged. If a scheduled text is overdue during downtime, it sends after a
worker recovers and permissions/roster checks pass.

Reminders create a private source-message notification, with transactional
completion and a dedupe key per reminder. They carry no message body. Cleared,
expired, deleted or inaccessible sources do not generate a reminder. Current
notification permissions, room preferences and DND control interruptions. A user
may have up to 200 active reminders.

## Disappearing messages

Supported timers are off, 24 hours, seven days and 90 days. Either person can
change a DM timer; group admins control group timers. A visible conversation
notice and timer-change history communicate the policy. A new timer applies to
newly sent messages, starting at actual send time; it does not rewrite timers
on existing messages or start when the recipient reads them.

The database's authorization visibility function rejects expired messages even
before cleanup runs. Timeline, search, bookmarks, thread history and attachment
access use that boundary. Open timelines also hide locally expired content and
recheck on focus/resume. The worker tombstones up to 200 expired messages per
iteration, clears ciphertext/plaintext and queues existing durable media cleanup.
The storage worker preserves objects still referenced by live messages/avatars.

Previously downloaded/exported copies cannot be recalled. Already issued signed
media links remain usable until their short-lived token expires. Browser caches,
backups and devices that never reconnect are not a secure remote-erasure service.

## Verification

See [UX_IMPLEMENTATION.md](../UX_IMPLEMENTATION.md) for the implementation ledger
and [DEVICE_ACCEPTANCE.md](DEVICE_ACCEPTANCE.md) for the Android acceptance run.
Physical iPhone/Safari and real provider delivery are explicitly unverified.

### Final verification boundary

The full security/experience browser run passed 18 desktop/mobile checks before
its final thread-attachment follow-up. The final thread-media regression and
recovery-suite rerun were not executed: automatic approval review could not
refresh its session token, and the user chose to finish with those checks
unverified. Thread attachments now use the existing durable media outbox,
attachment cards/viewer and manual retry controls; this final integration still
requires browser confirmation. The final PostgreSQL/Redis run passed 254 of 260
tests with six live R2 checks skipped and no failures. Physical Android testing
remains with the user; iPhone/Safari is unverified.
