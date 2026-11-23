I did a deep pass over both the current notification pipeline (push service, in-app bell, service worker) and the media pipeline (upload controller, multipart/resumable uploads, attachment proxy, client components). Good news: the foundation is already more solid than a lot of production apps — but there are real gaps between "functionally correct" and "feels like WhatsApp/Slack." Here's what I found, organized by area, with recommendations and questions before I touch anything.
What's already solid (don't need to rebuild)
- Uploads: allowlist + magic-byte signature verification, extension fallback only for meaningless MIME types, per-type size limits, resumable multipart uploads with checkpointed parts, duplicate-send protection, orphan cleanup on failure, rate limits on session/part/finalize endpoints.
- Downloads: everything is served through an authenticated proxy (never raw Cloudinary/R2 URLs), Range/If-Range support with ETag revalidation, forced Content-Disposition: attachment + nosniff (so an uploaded SVG can't become stored XSS), signed short-TTL URLs for streaming video/audio.
- Image previews: thumbnails are client-generated, bounded, base64 JPEG only (validateMediaMetadata rejects anything that isn't a tiny embedded data URI) — so there's no SSRF/tracking-pixel risk from a attacker-supplied preview_url.
- Client media UX: compression before upload (canvas re-encode, which also strips EXIF/GPS automatically), offline caching, resumable chunked downloads, retry-with-reason, inline audio/video players with speed/seek controls.
- Push plumbing: VAPID, subscription validation (endpoint allowlist, key-size checks), durable job queue with backoff/retry, session-bound subscriptions, renewal on pushsubscriptionchange, privacy-first payloads (closed-app notifications carry no message text today).
Gaps vs a "professional" chat app
Notifications
1. Push notifications are maximally generic, always. Every push is literally title: "Conclave", body: "You have new activity in Conclave" — no sender, no room, no preview, no avatar/icon. That's a deliberate privacy choice today, but it means push looks nothing like WhatsApp/Slack/Telegram, which show sender + preview by default and let you turn it off. This needs a product decision, not just an engineering fix (see Q1).
2. No notification grouping/collapsing. Each notification gets a unique tag (conclave:${id}), so 10 unread messages in one room create 10 separate OS notification entries instead of one that updates to "3 new messages in #general" (or a Slack-style grouped stack). 
3. No app badge count. No navigator.setAppBadge() — so there's no unread-count badge on the taskbar/dock/home-screen icon for the installed PWA.
4. No notification actions. No "Mark as read" / "Reply" action buttons on the OS notification (showNotification({ actions: [...] })).
5. No in-app toast + sound for new messages while foregrounded. There's a ToastContext/Toast.jsx in the codebase, but nothing wires an incoming-message notification to it, and I found no sound effect anywhere. Slack/Discord/WhatsApp all play a short sound and/or show a banner for messages in conversations you're not currently looking at.
6. Quiet hours / schedule-based DND only exists as a manual "mute until timestamp" — there's no recurring schedule (e.g., "mute 10pm–8am daily").
Images
7. No drag-and-drop file upload onto the chat window — only paste and the attach-menu file pickers exist. This is a baseline expectation in Slack/Discord/WhatsApp Web.
8. No upload queue visualization for multiple files at once beyond what's in the outbox — worth confirming the current multi-select experience is clear (progress per file, cancel per file) rather than just functional.
9. No lightbox gallery navigation (next/prev arrows through a conversation's media) in the single-image viewer — worth checking if MediaViewer.jsx already supports it (I didn't fully trace this) or if it only opens one image at a time.
Files / downloads
10. No malware/virus scanning integration. Signature verification confirms a file's real type but doesn't inspect for malicious content (e.g., a legitimately-typed PDF/zip with an embedded exploit, or an EICAR-style payload). Professional collaboration tools commonly integrate a scanning step (e.g., ClamAV or a cloud AV API) before a file is attachable.
11. No per-user/per-room upload throughput quota beyond the per-request rate limiter — e.g., no storage quota per team/room, no "largest files" view in room storage info beyond what GH-10 already added.
12. File expiry/retention for abandoned uploads exists at the infra level (storage_deletion_jobs), but I didn't see a user-facing retry affordance if a file silently expired mid-flight versus a clear "this file is no longer available" state — worth confirming UX parity with the image/video failure states shown above.
My recommended priority order
1. Notification content/grouping/badge (biggest "feels unprofessional" gap, pure UX, no new infra).
2. In-app toast + sound for background conversations.
3. Drag-and-drop upload.
4. Lightbox gallery navigation (if missing).
5. Malware scanning (infra decision — needs a provider and budget conversation).
6. Quiet-hours schedule (nice-to-have, lower urgency).

## Current implementation follow-up — 23 November 2026

The analysis above is preserved as historical notes. The current code already
implements push previews/grouping/icons, the app badge, in-app toast/sound,
drag-and-drop through composer validation, gallery navigation and upload queues.
These are not missing features. Former message E2EE was removed by migration 061;
its device keys and encryption-review tasks are retired.

This follow-up patches dependencies, shared socket limits, toast interaction,
hidden-tab suppression and authenticated accessibility. Read
[release evidence](docs/RELEASE_EVIDENCE.md) for actual checks and remaining
production acceptance; no earlier readiness statement substitutes for that
evidence. New functiosidebar  nality is tracked in
[deferred feature designs](docs/DEFERRED_FEATURES.md).
