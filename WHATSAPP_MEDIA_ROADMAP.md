# WhatsApp-style media flow roadmap

Last reviewed: 21 October 2026.

This checklist records the remaining work for Conclave's media send and receive
flow. Work through it in priority order. It describes the intended experience;
it does not claim exact parity with the current WhatsApp app.

## Current foundation

- Uploads use private Cloudflare R2 storage. Server uploads remain the default;
  resumable direct multipart uploads are available behind a deployment flag.
- Attachment endpoints check conversation membership before serving originals
  or issuing signed links. Deleted messages cannot request new attachment links.
- New photo/video messages carry bounded inline thumbnails and dimensions.
  A preview Worker supplies signed image previews for older files when deployed.
- New messages accept at most one attachment. Existing messages with multiple
  attachments remain readable.
- The composer saves the whole selection, including file Blobs and per-item
  captions, before closing the editor. Local media bubbles appear immediately;
  the account outbox then uploads and sends each item independently.
- Sender images use the device copy before requesting a preview.
- Received videos offer a download tile before loading the original.
- Shared media uses the attachment component rather than rendering opaque
  `r2://` keys directly.
- Text and media share an account-level IndexedDB outbox, client IDs,
  acknowledgements and delivery/read pointers. Uploads continue across in-app
  navigation, and successful upload references are saved before delivery.
- The caption callback parameter mismatch has been corrected in the source.
  Upload returning HTTP 201 means storage succeeded; a later client error can
  still prevent the message from being sent.

## Prioritized implementation checklist

### 1. Finish album metadata throughout the send flow

- [x] Forward the composer's `albumId` through `useMessages`, socket payloads and
      outbox records. Both live and restored messages preserve `album_id`.
- [x] Preserve album metadata in optimistic messages, restored drafts and retries.
- [x] Keep every media item independently addressable for replies, reactions,
      deletion, captions and delivery status.
- [x] Group only items that belong to the same conversation and sender.

### 2. Make media survive offline use and refresh

- [x] Save each file Blob, caption, reply target, client ID and album ID to
      IndexedDB before starting its upload.
- [x] Restore pending media messages after a refresh or reopening the app.
- [x] Queue media while offline and resume processing when connectivity returns.
- [x] Report storage failures visibly so unsent files cannot silently disappear.
- [x] Scope pending work to the signed-in account and handle logout safely.

### 3. Move uploads into message bubbles

- [x] Show the local photo, video or document bubble immediately after Send and
      close the preview dialog.
- [x] Upload in the background with progress, cancel, retry and reconnection handling.
- [x] Reuse a completed upload when message sending fails afterward.
- [x] Send completed uploads through the existing client-ID and acknowledgement
      path so retries cannot create duplicate messages.
- [x] Show distinct queued, uploading, awaiting acknowledgement and failed states.
- [x] Preserve captions and the album association after a partial batch failure.

### 4. Generate and cache thumbnails

- [x] Generate image dimensions and a small thumbnail before uploading.
- [x] Add video poster frames and duration.
- [x] Keep PDFs as document cards for this release; first-page rendering is deferred.
- [x] Include a JPEG preview capped at 12 KiB in authorized message metadata.
      This small inline preview needs no separate R2 object or token.
- [x] Reserve bubble space using dimensions so images do not shift the timeline.
- [x] Cache previews locally to avoid fetching a new signed preview URL on every mount.
- [x] Offer preview retry when loading fails; avoid automatically downloading the
      full original as the fallback.

### 5. Finish the receiver's download flow

- [x] Use consistent states: available to download, downloading, downloaded and failed.
- [x] Fetch originals when opened or explicitly downloaded. Optional video and
      document/audio auto-download preferences also apply; photos stay preview-only until opened.
- [x] Separate auto-download preferences from caching. Manual downloads always
      attempt to save a device copy, even with auto-download disabled.
- [x] Reopen downloaded media from the device cache, including while offline.
- [x] Add progress, cancellation and retry controls where missing.
- [x] Handle cache eviction and storage limits without displaying a stale
      downloaded state.

### 6. Build the album grid and media viewer

- [x] Group related messages visually into an album grid.
- [x] Preserve individual captions, replies, reactions, deletion and delivery state.
- [x] Add swipe or keyboard navigation between items.
- [x] Add image zoom and clear download controls.
- [x] Keep jump-to-message and highlight behavior working for each album item.
- [x] Check narrow screens, long captions and the mobile keyboard.

### 7. Add resumable transfers and direct uploads

- [x] Authorize direct multipart uploads to private R2 using short-lived signed URLs.
- [x] Persist upload sessions and completed parts so interrupted transfers can resume.
- [x] Verify upload ownership, actual size and file signatures before accepting
      finalized attachments; do not trust declared MIME types alone.
- [x] Support Range requests and resumable original downloads.
- [x] Define authenticated original delivery and caching rules for immutable media.
- [x] Document R2 CORS and provide a configuration helper, including exposed `ETag`.
- [ ] Apply bucket CORS in Cloudflare, then enable direct uploads in the server environment.

### 8. Finish storage cleanup and access handling

- [x] Schedule cleanup of uploads that remain unclaimed after a defined period.
- [x] Persist and retry failed object deletions through transactional deletion jobs.
- [x] Expire sessions and queue abort/delete jobs for incomplete uploads.
- [ ] Apply the one-day incomplete multipart lifecycle rule in Cloudflare.
- [x] Define how already-issued signed links and cached previews behave after deletion.
- [x] Preserve compatibility with existing Cloudinary attachments.
- [x] Document deployment, required bindings, lifecycle rules and cleanup operations.

### 9. Improve shared-media browsing

- [x] Add limits and cursor pagination to `listRoomMedia` and its client view.
- [x] Add document and audio sections alongside images and videos.
- [x] Add loading, empty, retry and error states.
- [x] Navigate from a media item back to its original message.

### 10. Verify the complete flow in the browser

- [x] Add media payload contract coverage for one attachment per message and
      album metadata across creation, history, reconnect and retry.
- [x] Test sender and receiver using Playwright with R2 mocked.
- [x] Test separate captions, album metadata and partial batch failure.
- [x] Test HTTP 201 upload success followed by message-send failure.
- [x] Test offline sending, refresh recovery, reconnect, retry and cancellation.
- [x] Test cached reopening, expired signed links and deleted-message access.
- [x] Test mobile layouts, long captions, media replies and album-item navigation.
- [ ] Perform a live browser R2/deployed-Worker smoke check after bucket setup.
      Live R2 multipart, Range and access checks already pass in the database suite.

## Follow-up improvements

- [x] Video compression and clear handling of files above the size limit.
- [x] Efficient forwarding and deduplication while preserving access controls.
- [x] Device-supported network preferences for auto-downloads.

## Completed sender-flow work: items 1–3

- `OutboxProvider` processes pending work for the signed-in account across routes.
- A file batch is accepted only after its IndexedDB transaction commits. Storage
  failures keep the editor and captions open and start no upload.
- Queued, uploading, awaiting-confirmation and failed states appear in bubbles.
- Failed uploads show the cause and require manual retry. Rate-limit waits are
  enforced before retry; message acknowledgement failures still retry safely with backoff.
- Completed uploads are reused after delivery failures with the same client ID.
- Upload cancellation aborts the request and removes the unsent draft. Once a send
  has been attempted and its outcome is unknown, the app resolves that attempt
  using its client ID rather than offering an unsafe cancellation.
- Account changes and logout stop the worker. Explicit logout retains the app's
  existing behavior of clearing device data, including unsent drafts.
- Offline session/profile, chat-list and room metadata are retained for refresh recovery.
  The production service worker caches the application shell and loaded modules;
  private API responses are not stored in that shell cache.
- Uploads require an open app tab. Closing the app stops processing; persisted
  drafts resume when the app is reopened and connected. A device must load the
  production app online once before its cached shell can open fully offline.
- Server uploads remain available while direct multipart uploads are disabled.
  Items 7–8 now add resumable transfers and durable storage cleanup.

## Completed preview/download work: items 4–5

- The durable outbox generates JPEG thumbnails up to 240 px, capped at 12 KiB,
  after optional image compression and before upload. Dimensions, video duration
  and poster metadata survive checkpoints, retries, live delivery and history.
- Browser decoding is bounded to six seconds for videos. Unsupported codecs can
  still be sent without a poster/duration; legacy files retain their fallback tile.
- PDFs remain document cards. There is no additional PDF rendering dependency.
- New previews are carried inside authorized message metadata, avoiding extra
  objects and preview-token round trips. Older Worker previews are cached by
  immutable media key, not by token. A preview failure offers retry and never
  silently downloads the original.
- Image/video bubbles reserve space from dimensions. Video posters show duration
  when known; remote originals do not mount a live video player until downloaded.
- Failed uploads wait for explicit retry, showing the storage/server/network
  reason in the bubble. Reconnecting alone does not retry a failed upload; media
  queued before upload starts still begins when connected.
- One download controller shares progress, cancellation, failure and retry state
  between views. Reopening a downloaded item reads its account-scoped device copy.
- Automatic downloads default off for videos and documents/audio. Photos stay
  preview-only until opened. Settings now describe automatic downloads separately
  from caching; manual downloads always attempt a cache write.
- Cached bytes share the 250 MiB LRU budget. Eviction/clear events invalidate
  visible download state across tabs; focus rechecks storage. Quota failures
  explicitly show that a copy is available only for the current visit.
- The real production offline test now checks both an unsent draft and a received
  photo after downloading, reloading offline and reopening the conversation.
- Migration 027 adds video duration. Apply it before restarting the backend.
  Redeploy the preview Worker for its new CORS response headers, which let the
  client cache legacy preview bytes. Inline previews on new messages do not need
  that Worker deployment. No remote deployment is performed by these changes.

## Album, transfer and cleanup work: items 6–8

- Adjacent album messages render in a grid, preserving each item's caption,
  actions and delivery state. The viewer supports swipe/keyboard navigation,
  zoom, download controls and jump/highlight.
- Multipart sessions persist on both server and device. Explicit retry reuses
  completed parts; finalized files are checked for ownership, byte length and
  file signature before attachment claims.
- Authenticated originals support Range/ETag downloads. Completed chunks survive
  interruption in the account's device cache; originals remain private/no-store
  on the API and share the existing local cache budget.
- A scheduled worker expires unclaimed uploads after one day and processes
  durable deletion/abort jobs with backoff. Active avatars/live attachments are
  protected. Deleted messages immediately lose endpoint access; already-issued
  links have bounded lifetimes and device copies cannot be remotely revoked.
- Migrations 028–029 are applied locally. Production still needs migrations and
  the bucket CORS/lifecycle settings. Direct uploads remain disabled locally.
- See [media storage operations](docs/MEDIA_STORAGE.md) for configuration,
  rollout, legacy Cloudinary support and cleanup monitoring.

## Shared-file browsing: item 9

- Room and DM info pages now have Media, Documents and Audio sections.
- Shared files load in cursor pages of 24 (API maximum 100). Sequence/attachment
  cursors handle legacy multi-file messages and concurrent inserts/deletes.
- Initial loading, empty sections, first-page errors and next-page errors are
  distinct. Retry retains previously loaded rows; section changes abort stale
  requests, and Refresh starts a new page. Local clear-history cutoffs apply.
- Show message opens a bounded 50-message window ending at the selected message,
  scrolls/highlights it and offers Return to latest. Deleted/missing/locally
  cleared targets show errors; sending returns to ordinary latest history.
- Migration 030 indexes attachment lookups. It is applied locally; apply it in
  production before deploying the updated backend.

## Development checks

Apply backend migrations with `cd backend` then `npm run migrate`. Migration
025 adds album metadata; migration 026 indexes the album ownership lookup;
migration 027 adds video duration to uploads and attachments. Migrations 028–029
add resumable sessions, durable deletion jobs, retirement guards and cleanup backfill.

From `client`:

```bash
npm test
npm run build
npx playwright test e2e/shared-media.spec.js e2e/media-albums.spec.js e2e/media-downloads.spec.js e2e/media-outbox.spec.js e2e/messaging-quality.spec.js --project=app-desktop --project=app-mobile
npx playwright test --config=playwright.media-production.config.js
npx playwright test --config=playwright.media-regression.config.js
npx playwright test --config=playwright.media-live.config.js
```

The production test builds and serves the app locally on port 5176. It checks a
real service-worker-assisted offline reload with mocked API data. The normal
browser suite mocks R2 and exercises upload, retry, cancellation, storage failure,
partial albums, refresh recovery and account restoration.

From `backend`, run `npm test` and `npm run test:db`. The database suite uses
uniquely named disposable databases and includes live R2 round trips when the
storage credentials are configured.

## Verification of items 6–8 on 21 October 2026

- Client unit tests: 35 passed. Backend unit tests: 31 passed.
- Database/integration tests: 202 passed, no skips, including live R2 multipart
  resume/finalization, Range responses, MIME rejection and deleted-file access.
- Preview Worker tests: 4 passed. Production build passed.
- Desktop/mobile browser coverage: 56 applicable scenarios passed across the
  main run and a targeted rerun; two platform-specific cases were intentionally
  skipped. The desktop upload-resume test initially timed out while reopening
  the app. Adding an explicit composer-ready wait after reload made the rerun pass.
- Production service-worker offline tests: 2 passed, covering desktop/mobile
  draft restoration and reopening a downloaded received photo.
- Bucket CORS/lifecycle configuration and a real browser direct-upload smoke
  check remain pending. No deployment or commit was performed.

## Verification of item 9 on 21 October 2026

- Backend unit tests: 33 passed. Client unit tests: 36 passed, including a
  deterministic service-worker handoff/cache-isolation regression test.
- Database/integration suite: 203 passed, no skips. The final shared-file query
  also passed a targeted rerun after the index predicate/date-fixture changes.
- Desktop/mobile browser coverage: 44 applicable scenarios passed across the
  main run and separate reruns; two platform-specific cases were skipped.
  This includes shared-file pagination/retry, document/audio browsing, manual
  download, stale-request cancellation, clear-history filtering, context jumps,
  mobile wrapping, offline text and existing media outbox/retry behavior.
- The final production build and both real service-worker offline tests passed.
  An observed worker-ready/uncontrolled-page race was fixed by claiming clients
  during the ready-page asset handshake. No private API caching was added.
- Concurrent build/browser runs hit startup timeouts; separate reruns passed.
- Migration 030 is applied locally. No deployment or commit was performed.

## Recommended next work

Finish the Cloudflare bucket settings in [docs/MEDIA_STORAGE.md](docs/MEDIA_STORAGE.md),
verify the deployed preview Worker, then enable `R2_DIRECT_UPLOADS_ENABLED=true`
and restart the backend after CORS/lifecycle settings are in place. The current
credentials cannot inspect bucket configuration, so no bucket changes were applied.
Code for items 6–8 is implemented; Cloudflare configuration remains pending.
Item 9 and the follow-up improvements are implemented. Finish **item 10:
deployed storage smoke checks** after bucket setup and Worker deployment.

Update this checklist as work is completed. A passing build or backend suite
alone does not prove the complete sender/receiver browser flow.


## Item 10 and follow-up implementation — 21 October 2026

- Optional browser video compression preserves audio and per-file captions. It
  accepts source clips up to 200 MiB and two minutes, targets a 1280-pixel long
  edge, and enforces the existing 50 MiB send limit. Unsupported browsers retain
  the original and explain how to trim it. Compression can be canceled.
- Forwarding uses the existing durable outbox, including offline destinations.
  The server checks both conversations, DM blocks and source visibility. Each
  forwarded message gets new message/attachment IDs while referencing the same
  immutable storage object. This deduplicates forwards; newly selected uploads
  are not globally deduplicated by a content hash. Live forwards retain their
  objects when the source message is deleted.
- Download preferences support any network, known Wi-Fi/Ethernet, or a fast
  connection estimate, plus respecting Data Saver. Unknown network information
  is handled conservatively for restrictive preferences. A manual download
  continues when automatic downloads are disabled by a policy change.
- The local real-R2 browser harness creates a disposable database and removes its
  uploaded objects at shutdown. It exercises actual sender/receiver delivery,
  a lost HTTP 201 upload response, manual retry after refresh, media playback,
  downloads, offline photo reopening, unauthorized access and deleted-message
  denial. Worker errors remain test failures, not a successful rollout claim.
- Deployment remains pending: bucket CORS/lifecycle settings have not been
  applied, the app has not been deployed, and the existing Worker returns 502
  for signed previews without CORS headers. Keep direct uploads disabled until
  the setup and live deployment checks in `docs/MEDIA_STORAGE.md` succeed.

### Final local regression results

- Client units: 40 passed. Backend units: 33 passed. Worker units: 4 passed.
- Database/integration suite: 204 passed, including real R2 round trips. The
  forwarding access/block/deletion test also passed a targeted final rerun.
- Desktop/mobile media regression suite: 40 passed. This includes encoded audio
  preservation, caption preservation, offline forwarding and network policies.
- Production build and both service-worker offline browser tests passed.
- A complete deployment pass is still pending. Live signed Worker requests return
  HTTP 502 (`Could not create preview`) and lack CORS headers; these are recorded
  as failures in the live configuration, not skipped or counted as passing.
- No changes were committed or deployed. Backend port remains 7000 and direct
  uploads remain disabled pending bucket configuration.

- Final real-R2 browser run: both desktop and mobile completed the core upload,
  manual-retry, playback, saved-file, Range, offline-cache, deletion-denial and
  layout checks. Both test cases failed only their explicit deployed-Worker
  assertions (502 response and missing CORS). Temporary databases were removed.
