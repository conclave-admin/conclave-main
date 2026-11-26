# Messaging experience implementation

Scope: the 17 requested improvements. Implementation status is separate from
physical-device and production acceptance. No changes have been committed.

| #   | Improvement                              | Implementation and evidence                                                                                                                                                                                                          |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Progressive inbox previews               | Implemented. Cached/server chat rows render before independent encrypted previews resolve; account/generation checks reject stale results.                                                                                           |
| 2   | Actionable failures                      | Implemented. Preview retry or device-recovery actions, readable key-unavailable copy, preserved draft/media errors and cancellation failures.                                                                                        |
| 3   | Conversation drafts                      | Implemented. Account/room/thread text and reply context persist locally. Unit and desktop/mobile navigation checks.                                                                                                                  |
| 4   | Message search                           | Implemented. Header dialog, server search in readable rooms, local decrypted search, sender/date filters, source navigation and highlighting.                                                                                        |
| 5   | Safer personal deletion                  | Implemented. In-app confirmation explains personal clearing, preserved peer history/membership and pending sends. Browser and backend checks.                                                                                        |
| 6   | Accessibility                            | Implemented. Dialog focus containment, background isolation, nested-dialog restoration, keyboard menu navigation and named controls. Unit/browser checks; TalkBack acceptance remains open.                                          |
| 7   | Reading position                         | Implemented. Account/room anchor and offset, bounded context below the anchor, explicit-link priority and unavailable-anchor fallback. Desktop/mobile navigation check.                                                              |
| 8   | Compact media status                     | Implemented. Idle hints removed; progress, cancellation, failed download retry and offline availability retained. Existing media regressions included.                                                                               |
| 9   | Device validation                        | Automated mobile-browser checks and Android checklist added. **User Android run pending. Physical iPhone/Safari unavailable and unverified.**                                                                                        |
| 10  | Browser regression CI                    | Implemented in `verify.yml`: Chromium, disposable PostgreSQL/Redis, recovery and security/experience suites, failure artifacts. Remote GitHub run awaits push.                                                                       |
| 11  | Real threads                             | Implemented. Persisted roots, paged history, reply counts, per-user unread positions, Threads inbox, separate drafts and durable sending. Signed encrypted thread context and membership checks.                                     |
| 12  | Rich text and links                      | Implemented. Escaped formatting, code blocks/copy, safe HTTP(S) autolinks and opt-in domain/URL cards. No external Open Graph fetch or raw HTML execution.                                                                           |
| 13  | Reactions                                | Implemented. Emoji Mart picker in the composer and reaction menus, with API validation against its native emoji dataset. The follow-up picker change has not had a browser check.                                                    |
| 14  | Notification controls                    | Implemented. All/mentions/none, timed/indefinite mute, DND, expiring status and admin-only `@here`/`@channel`. Unsaved edits survive background synchronization.                                                                     |
| 15  | Saved messages, scheduling and reminders | Implemented. Personal bookmarks and encrypted notes, text scheduling while closed, cancellation, recipient-change review/re-encryption, private reminders and Message activity. Worker concurrency, key rotation and browser checks. |
| 16  | Disappearing messages                    | Implemented. Off/24h/7d/90d; DM/group permissions, visible policy/history, authorization at expiry, local hiding, tombstones and durable media cleanup. SQL checks include attachment access before cleanup.                         |
| 17  | Read more                                | Implemented. Collapse/expand long paragraphs/code, full-text copying and expanded highlighted source results. Responsive browser checks.                                                                                             |

## Verification ledger

- Backend unit checks before the Emoji Mart follow-up: 39 passed.
- Client unit checks before the Emoji Mart follow-up: 91 passed.
- Full PostgreSQL/Redis regression run before the Emoji Mart follow-up: 254
  passed, six live R2 tests skipped, zero failures. An additional focused run passed all eight new experience tests,
  including encrypted rescheduling after device rotation and expired-media cleanup.
- Complete security/experience browser run: 18 passed across desktop and mobile
  Chromium. This run preceded the final thread-media and Emoji Mart follow-ups.
- Final thread-attachment regression and recovery-suite rerun: **unverified**.
  Automatic approval review could not refresh its session token; the user chose
  to finish with the remaining checks unverified. No attempt was made to bypass
  review.
- Production client build passed after the Emoji Mart follow-up. Its unit and
  browser checks remain unrun.
- Workflow YAML parses, and `git diff --check` passes.

Live R2 round trips, deployed push, physical-device acceptance and production
load are not established by mocked/emulated tests.

## Operational notes

1. Use Node 22. Apply the new backend migrations with `npm run migrate`, then
   restart the API. The API process runs schedules, reminders and expiry work;
   existing storage cleanup processes queued object deletion.
2. Scheduling is **text-only** in this release. Encrypted schedules stop for
   review if current recipients/trusted devices change. A review reseals the
   content on the user's device. Upload retries remain manual.
3. Disappearing timers start at send time and apply to new messages only. Already
   downloaded copies cannot be recalled; issued media tokens live until expiry.
4. Drafts and reading positions belong to the current device/browser account.
   Encrypted search covers history available on that device.
5. Complete [Android acceptance](docs/DEVICE_ACCEPTANCE.md) on an HTTPS build.

See [feature behavior and deployment details](docs/MESSAGING_EXPERIENCE.md).
