# Private attachment preview Worker

This Worker reads original images from the private `conclave-uploads` R2
bucket, creates one fixed 640×480 WebP chat preview with the Images binding,
and caches that immutable transformation at the edge. It never serves an R2
object without first validating the short-lived HMAC token issued by the API.
The API checks room membership before it issues that token.

## Configure and deploy

1. Install the Worker tools with `npm install` in this directory.
2. Confirm the `conclave-uploads` bucket exists in the same Cloudflare account.
3. Set a random secret of at least 32 characters on the Worker:
   `npx wrangler secret put PREVIEW_SIGNING_SECRET`
4. Set the **same** secret and the deployed Worker URL in the backend environment:
   `R2_PREVIEW_SIGNING_SECRET` and `R2_PREVIEW_WORKER_URL`.
5. Run `npm test`, then deploy with `npm run deploy`.
6. Copy the Worker URL into the backend environment and restart the API.

Keep the R2 bucket private. The signed preview link is a bearer link valid for
five minutes. The Worker verifies the signature and expiration before reading
its edge cache; the cache key excludes the token, so valid users can reuse the
same transformed bytes. The browser receives a 30-second private cache policy.

The Images binding accepts source images up to 20 MB. Larger images remain
available through the existing authenticated original-download flow and can
fall back to that full image in the client.

The Worker uses Cloudflare's Images binding, which needs Images transformations
enabled for the account. R2 stays the source of truth; this Worker does not
copy originals into Cloudflare Images storage.
