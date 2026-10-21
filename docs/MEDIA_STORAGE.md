# Private media operations

Reviewed: 21 October 2026.

## Album and viewer behaviour

Adjacent photo/video messages with the same album, conversation and sender render
in a grid. Each tile retains its message ID, caption, reply, reactions, moderation
and delivery state. The viewer supports Previous/Next, arrow keys, horizontal
swipe, photo zoom, pinch, download and Show message. Deleted items leave the
viewer while their tombstones retain the timeline position. Legacy messages
containing several attachments remain readable.

## Direct uploads

1. Apply migrations through 031, then restart the backend.
2. Set `R2_ALLOWED_ORIGINS` to the exact client origins, separated by commas.
   Include development origins only when needed. The default is `CLIENT_ORIGIN`.
3. Run `npm run storage:configure` from `backend`. This reads the bucket settings
   and prints a merged plan. It preserves unrelated CORS and lifecycle rules.
4. Review the output. Run `npm run storage:configure -- --apply` to apply it using
   credentials allowed to manage the bucket. An object-only R2 token may require
   a separate administrative token or the equivalent dashboard changes.

If the supplied key returns AccessDenied, run
`npm run storage:configure -- --template` to print the exact proposed additions
without accessing the bucket. In Cloudflare R2, open the bucket's Settings:

- Add the printed CORS rule, preserving unrelated existing rules. Set explicit
  app origins and expose `ETag` so the browser can checkpoint part completion.
- Add an object lifecycle rule for prefix `conclave/attachments/`, with the action
  **abort incomplete multipart uploads after 1 day**. Preserve completed objects.
- A bucket administrator can use `--apply` with appropriately scoped credentials.

5. Set `R2_DIRECT_UPLOADS_ENABLED=true` in the backend environment and restart it.
   Refresh clients so their capability check uses the new setting.

The generated CORS rule permits PUT/GET/HEAD from explicit origins and exposes
ETag, Content-Range, Accept-Ranges and Content-Length. The bucket stays private.
The lifecycle rule aborts incomplete multipart uploads under
`conclave/attachments/` after one day. It does not expire completed objects.

The browser asks the authenticated API to authorize a session for a conversation,
client ID, name, MIME type, size and bounded thumbnail metadata. The server
checks membership and limits. Parts are 8 MiB, except the final part, with five
minute signed URLs. API credentials and API bearer tokens never go to R2.

The IndexedDB outbox records the session and completed parts. Restoring a session
reads the authoritative part list from R2 and skips those bytes. Failed transfers
show the reason and require Retry. Reconnect can start queued work; it does not
retry a failed upload. Finalization reads actual part sizes, HEAD size and file
signatures before recording the upload as claimable. ZIP/Office inspection can
read more bytes through a stream; it does not buffer the full original in RAM.
Signature checks identify formats; they are not a malware scanner or a complete
media decoder.

Completion is idempotent. If completion succeeded but its response was lost,
retrying returns the same reference. One-time attachment claiming still happens
inside message creation. Expired/rejected sessions use a new object key on Retry,
so an older part URL cannot alter a new attempt. Sessions expire after one day.
The API caps active sessions per account and rate-limits signing/creation.

When the capability flag is false, existing server-owned multipart-form uploads
continue to work. That path also validates signatures. In-progress direct
sessions can finish after a feature flag change.

## Original delivery and resumable downloads

Originals use the authenticated attachment API. Every network request, including
Range requests, checks conversation membership and deleted state. R2 responses
support a single bounded, open-ended or suffix byte range, strong ETag/If-Range,
206 and 416. An If-Range mismatch returns the current full representation.
Legacy Cloudinary delivery can return a complete 200 response when Range is not
supported; the client uses it as a whole file.

Clients retain completed 2 MiB chunks in the bounded, account-scoped device
cache. Retry resumes after those chunks, including after reload. ETags prevent
combining different representations. A full cached original replaces its partial
chunks. Clearing downloads clears partial bytes as well; eviction means those
bytes must be downloaded again. Pending upload Blobs live separately in the
outbox and are not removed by clearing downloads.

API originals use `Cache-Control: private, no-store`; immutable per-upload keys
identify local cache entries. Thumbnail metadata is returned through authorized
message APIs. Legacy signed Worker previews keep their existing private token
checks and device caching.

## Deletion and retention

A database trigger records deletion jobs in the same transaction as a message's
soft deletion. The attachment endpoint denies new access as soon as that
transaction commits. Migration 029 queues objects from older deleted messages.
A failed storage operation stays in `storage_deletion_jobs` with attempt count,
next attempt and a bounded error code. Backoff grows from 30 seconds to one day.

Each API process runs the cleanup sweep every five minutes, with row locks and
SKIP LOCKED to share work safely. `MEDIA_CLEANUP_INTERVAL_MS` changes the interval
(minimum one minute). Run `npm run media:cleanup` for a bounded manual sweep or
from a scheduled job if API processes sleep between requests.

The sweep expires old sessions, queues their multipart aborts and objects, and
retires unclaimed uploads older than one day. It protects active user/room
pictures and objects referenced by live messages. Avatar assignment and message
claims serialize with retirement. Retired files cannot be claimed again. Jobs
recheck active references before deleting. Referenced objects are postponed and
checked again later so replacing a picture cannot strand a retired object.
Cloudinary references with stored coordinates use their existing resource type; rows without storage coordinates
require a separate legacy inventory review.

Inspect failures without exposing credentials:

```sql
SELECT id, provider, attempts, next_attempt_at, last_error
FROM storage_deletion_jobs ORDER BY next_attempt_at;
```

After resolving the cause, bring a specific job forward:

```sql
UPDATE storage_deletion_jobs SET next_attempt_at = NOW() WHERE id = <job_id>;
```

## Issued links and device copies

New R2 original links issued by `/attachments/:id/url` last 60 seconds. Existing
links issued before this change can retain their earlier expiry. Legacy
Cloudinary links may last one hour. Worker preview links last five minutes.
Already-issued links and authorized cached Worker previews can remain usable
until their token expires; deletion jobs can remove underlying bytes sooner.
Device copies already downloaded cannot be remotely revoked. Clearing this
device's downloads or signing out removes its local media cache.

## Verification and rollout

- `backend`: `npm test`, `npm run test:db`.
- `client`: `npm test`, `npm run build`.
- Browser: `npx playwright test e2e/media-albums.spec.js e2e/media-downloads.spec.js e2e/media-outbox.spec.js e2e/messaging-quality.spec.js --project=app-desktop --project=app-mobile`.
- Real offline app: `npx playwright test --config=playwright.media-production.config.js`.

Database tests create disposable databases. Configured R2 integration tests use
unique test objects and remove them afterward. Browser tests mock R2 for failure
and resume cases. A real browser upload against the configured bucket is still
needed to prove the deployed CORS origins and exposed ETag header.

Primary references: [multipart rules](https://developers.cloudflare.com/r2/objects/upload-objects/),
[CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/),
[S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/),
[file signature detection](https://github.com/sindresorhus/file-type).


## Local live-R2 smoke test

Run from `client`:

```bash
npx playwright test --config=playwright.media-live.config.js
```

This starts a separate API on 7100 and client on 5177, creates a uniquely named
PostgreSQL database, applies migrations and uses disposable accounts. It sends
photo/video/audio/document bytes through the real API into private R2, deliberately
loses one successful upload response, reloads and retries manually, then checks
receiver downloads, video decoding, byte ranges, offline image reuse, outsider
rejection and deleted-file access. No bucket settings or deployed app are changed.
Direct uploads are deliberately off in this harness until bucket setup is complete.

The server removes its R2 objects and disposable database during graceful shutdown.
Failed object cleanup writes a credential-free `/tmp/conclave_browser_*-storage-cleanup.json`
manifest and exits with an error. Do not force-kill the harness during cleanup.
The configured deployed Worker is also probed. HTTP failures and missing browser
CORS headers are explicit failing assertions, with deployment-required annotations.
Core media checks continue so the final artifacts distinguish working R2 transfers
from an incomplete Worker rollout.

A localhost smoke test does not verify the deployed app's origins, configuration or
service worker. After applying bucket settings and deploying the application,
repeat the browser checks using the deployed frontend/API URLs and direct uploads.

## Preview Worker rollout

The live probe currently returns HTTP 502 for a signed preview and omits CORS
headers; the response body is `Could not create preview`. Deploy the current
source and verify its MEDIA bucket binding, IMAGES
binding and signing secret before treating browser previews as working. From
`media-preview-worker`, review `wrangler.toml`, then deploy:

```bash
npx wrangler deploy
```

Keep the existing `R2_PREVIEW_SIGNING_SECRET` Worker secret synchronized with the
backend; do not put it in `wrangler.toml`. Keep the `MEDIA` bucket binding private
and the `IMAGES` transformation binding. No remote deployment is performed by the
local test command. After deployment, the Worker preview response must expose
`Access-Control-Allow-Origin` for browser fetches.

## Forwarded media retention

Forwarded messages get new message/attachment IDs and reuse the immutable storage
object. The server copies the authorized source body and metadata, verifies source
and destination membership, and respects destination DM blocks. The recipient only
sees the forwarded marker, not source-room IDs or source-membership permissions.
Each copy has its own reactions, replies, deletion and delivery state. Retries use
client IDs; forwards queue offline in the existing outbox without file uploads.
Legacy multi-file messages forward as separate messages sharing a new album ID.

Deleting a source immediately denies access through its attachment ID. Authorized
forwarded copies remain readable; deletion jobs check all live attachment references
before removing bytes, including legacy records without an upload-provenance row.
This is deduplication of forwarded copies by immutable object identity. Newly selected
files still follow the normal independently verified upload path.
