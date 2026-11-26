# Conclave UI/UX findings and production readiness

Reviewed: **24 November 2026 (Africa/Lagos)**. Status: **UI-01–14 implemented or source-verified; live release acceptance remains open**.

## Scope and evidence

This report replaces the unstructured comparison previously pasted below the historical notes. It compares Conclave's current interfaces with messaging patterns from WhatsApp and collaboration patterns from Slack/Discord while preserving Conclave's purple theme, existing features and privacy rules.

- The preceding visual review captured desktop **1440×900** and mobile **390×844** screens using the local development preview. This follow-up re-checked the implementation against those findings; it did not run a new browser session or full CI.
- Captured surfaces: chat list, conversation, room info, member profile, settings, catch-up digest, tasks, decisions, a dark-theme decision screen and the shared-media failure state.
- Screenshot evidence is local and temporary: `/tmp/conclave-audit-20261123/`. The overview is `review-overview.png`; route text and overflow observations are in `observations.json`. Archive sanitized captures with the eventual candidate release before relying on them as maintained release evidence.
- Preview data is synthetic. Unavailable fixture thumbnails demonstrate the layout of a failure state, **not a confirmed production R2 failure**. Actual voice recording, staging, login/recovery, provider delivery and every dark-theme screen were not visually re-audited in this pass.
- No horizontal document overflow was recorded on the initial eight routes at either tested viewport. This does not establish behavior at all widths, zoom levels or with real long names.
- See [release evidence](docs/RELEASE_EVIDENCE.md) for executable checks and [deferred features](docs/DEFERRED_FEATURES.md) for intentionally unimplemented functionality. No screenshot establishes full accessibility compliance or production readiness.

## Priority definitions

- **Launch gate:** an unresolved operational, trust or acceptance requirement before a broad public release; not necessarily a UI coding defect.
- **P1:** correctness/accessibility issues to address before release.
- **P2:** usability improvements recommended for the production UI pass.
- **P3:** optional polish or later product work.

## Confirmed UI and behavior findings

Rows below remain **open** unless explicitly marked resolved or described as verification-only. Recommendations on open rows are proposed changes, not claims that they already exist.

| ID | Priority / evidence | Finding and user impact | Recommended change | Acceptance criteria |
| --- | --- | --- | --- | --- |
| UI-01 | ✅ Resolved 24 Nov 2026 · mobile browser + source | Decisions now uses a compact title/action row and horizontally scrollable overview chips. Search, conversation/status filters, creation and pagination are unchanged. | Implemented. | The focused 390×844 regression passed with the first decision beginning inside the initial viewport. |
| UI-02 | ✅ Resolved 24 Nov 2026 · source + build | Tasks now uses a compact title/action row, filter control and status chips before the board. Desktop columns, assignment metadata, creation, task details and pagination remain available. | Implemented. | A focused mobile viewport regression is committed for the next Playwright run; execution is paused at the user's request. The production build passes. |
| UI-03 | ✅ Resolved 24 Nov 2026 · database regression + source | Task status totals now come from a full-scope server aggregation, independent of the current cursor page. “Assigned to me” is sent as a server-side assignee filter and resets pagination safely. | Implemented without fetching every task. | Disposable-database regressions pass for totals across two pages, an assigned task beyond page one, stable totals on page two, and decision-scoped totals before and after completion. |
| UI-04 | ✅ Resolved 24 Nov 2026 · source + build | Task filters expose `aria-pressed`, retain visible keyboard focus and strengthen inactive hover feedback. | Implemented. | Selection semantics and theme-visible styling are present; production build passes. |
| UI-05 | ✅ Resolved 24 Nov 2026 · source + build | Settings categories use a wrapped mobile grid, active-section feedback and scroll tracking while keeping every form mounted. | Implemented. | All categories remain keyboard reachable; navigation honors reduced motion and focuses the selected section without discarding unsaved form state. |
| UI-06 | ✅ Resolved 24 Nov 2026 · source + build | Messages and decisions now share one compact native expandable “Pinned items” area, hidden when empty. | Implemented. | Native summary keyboard behavior is retained; existing unpin, bookmark and source-navigation actions remain in their original components. |
| UI-07 | ✅ Resolved 24 Nov 2026 · source + build | Room info now has a direct conversation return link, a compact identity row and denser shortcuts with long-name wrapping. | Implemented. | Admin controls and permissions are unchanged; production build passes. |
| UI-08 | ✅ Resolved 24 Nov 2026 · source + build | Unknown room and member presence is omitted instead of being presented as “Presence unavailable.” Known presence states retain their existing privacy-aware labels. | Implemented. | Unknown is not represented as offline; known online/activity states remain visible. |
| UI-09 | ✅ Resolved 24 Nov 2026 · source + build | Shared-media tiles are consistently square, with compact centered retry/cancel actions and reserved corners for date and source navigation. | Implemented. | Loading, failure and cached-state data remain available without progress/status text expanding the tile; open and source destinations are unchanged. Browser matrix remains an acceptance task. |
| UI-10 | ✅ Resolved 24 Nov 2026 · source + build | The catch-up summary has a separate 44px dismiss control and stores dismissal per account for the current browser session and digest signature. | Implemented. | Dismissal does not call read APIs; a changed digest reappears and Catch up remains available through its existing route/navigation. |
| UI-11 | ✅ Resolved 24 Nov 2026 · source + build | Catch-up cards and room sections are denser. Each item retains its action, timestamp and actor while omitting the room name already supplied by its section. | Implemented. | Priority groups, mentions, assignments, room/all read actions, expansion, older-page loading and destinations are unchanged. |
| UI-12 | ✅ Resolved 24 Nov 2026 · source + build | Member profile uses the same direct back-control pattern as room info, a compact horizontal identity area, long-name wrapping and denser shared-room rows. | Implemented. | About, Message, avatar viewing and groups in common remain available; the existing profile/shared-room authorization calls and exposed fields are unchanged. |
| UI-13 | ✅ Resolved 24 Nov 2026 · source + build | Desktop and drawer navigation now group every destination under Communication, Work and Explore. The collapsed rail uses separators while expanded states expose group labels. | Implemented. | Routes and unread indicators are preserved; hover/focus expansion, pinning, mobile drawer and bottom navigation behavior are unchanged. |
| UI-14 | ✅ Source audit resolved 24 Nov 2026 · measured tokens + unit + build | Shared text and semantic tokens meet WCAG AA contrast on their app surfaces. Dark filled brand controls outside the app shell were corrected from 2.98:1 to 5.45:1, and a shared visible focus outline now covers interactive surfaces. | Implemented and source-verified. | Focus-outline contrast is at least 5.73:1. Modal source restores trigger focus; nested dialog isolation passes its unit regression. Browser zoom/reflow and physical-device checks remain accurately tracked under REL-03 because browser execution is paused. |

### Source map

Line numbers are intentionally omitted because the implementation is still changing.

- UI-01: [Decisions.jsx](client/src/pages/Decisions.jsx), compact header, overview chips and retained search/filter controls.
- UI-02–04: [Tasks.jsx](client/src/pages/Tasks.jsx), server-provided `counts`, scoped `listTasks`, `nextCursor` and semantic task filters; [tasks.controller.js](backend/src/controllers/tasks.controller.js), full-scope aggregation before cursor pagination.
- UI-05: [Settings.jsx](client/src/pages/Settings.jsx), wrapped category navigation, active-section tracking and reduced-motion-aware focus.
- UI-06: [PinnedItemsPanel.jsx](client/src/components/chat/PinnedItemsPanel.jsx), composing the existing message and decision pin actions into one expandable area in [Room.jsx](client/src/pages/Room.jsx).
- UI-07–08: [RoomInfo.jsx](client/src/pages/RoomInfo.jsx), compact identity/navigation and omission of unknown presence.
- UI-09: [SharedMediaBrowser.jsx](client/src/components/chat/SharedMediaBrowser.jsx), square tiles and reserved overlays; [AttachmentCard.jsx](client/src/components/chat/AttachmentCard.jsx), compact preview recovery controls.
- UI-10: [CatchUpCard.jsx](client/src/components/chats/CatchUpCard.jsx), per-account session dismissal keyed to the current digest.
- UI-11: [CatchUpDigestPage.jsx](client/src/pages/CatchUpDigestPage.jsx), compact attributed update cards and room groups.
- UI-12: [MemberProfile.jsx](client/src/pages/MemberProfile.jsx), compact identity and consistent nested navigation.
- UI-13: [NavRail.jsx](client/src/components/layout/NavRail.jsx), labelled communication, work and exploration groups while retaining the existing shell behavior.
- UI-14: [index.css](client/src/index.css), measured theme tokens, dark filled-brand correction, shared focus indication and reduced-motion safeguards; [Modal.jsx](client/src/components/ui/Modal.jsx) and [dialogFocus.js](client/src/lib/dialogFocus.js), dialog containment and focus restoration.

## Already implemented: do not reopen as missing features

The original historical analysis below contains stale or uncertain claims. The following are current implemented behavior, not new work requested by this review:

- Notification previews with privacy control, kind/room grouping, icons, app badge, in-app alerts and sound, hidden-tab suppression, and preference updates without a reload. Live provider acceptance is a separate requirement.
- Drag-and-drop through composer validation, multi-file staging/captions/cancellation, media albums, viewer navigation, reactions and shared-media tabs.
- Custom live recording/playback waveforms and the selected hybrid recording interaction. Physical microphone/device acceptance remains separate.
- Automatic background media downloads, IndexedDB originals, account-scoped storage controls and cache invalidation. The latest changes reuse loaded Blobs and preserve their identity during cache rechecks.
- Download progress bars, numerical download percentages and redundant offline-success/failure announcements have been removed from attachment cards and the viewer. Upload progress remains intentional.
- Essential screen-reader labels, skip navigation and meaningful read/upload announcements belong in production; removing `sr-only` indiscriminately would create accessibility defects.

Browser storage may be cleared or evicted. A usable in-memory copy does not guarantee persistence after reload. Do not describe ordinary browser eviction as proof that every media open still redownloads.

## Production release gates and acceptance gaps

These remain **open or unverified**; this review did not exercise them live.

| ID | Gate | Required evidence or decision |
| --- | --- | --- |
| REL-01 | Privacy and terms still contain operator-dependent draft details. | Supply and approve legal entity, contacts, retention, providers/regions and applicable terms. Keep honest draft disclosure until completed. See [StaticPage.jsx](client/src/pages/StaticPage.jsx). |
| REL-02 | Report submission exists, but platform moderator review/enforcement remains deferred. | Explicitly decide the audience and operational response process before public use; do not imply reports are being reviewed without one. Source inspection found a `user_reports` INSERT in [users.controller.js](backend/src/controllers/users.controller.js), not a triage interface. This document does not authorize implementing deferred moderation. |
| REL-03 | Physical-device and accessibility acceptance incomplete. | Test mobile keyboard resizing, safe areas, touch controls, mic permission denial, interruptions, recording lock/cancel, playback, focus, screen readers and reduced motion on the supported browser/device matrix. |
| REL-04 | Live notification/email and remaining storage-browser acceptance incomplete. | Record push delivery/click/grouping/privacy, verification/recovery inbox delivery and remaining R2 CORS/Worker/multipart/browser scenarios. Some R2 API checks already passed; do not describe all R2 integration as untested. |
| REL-05 | Load, long-history/media memory and backup restore evidence incomplete. | Record realistic workloads, failure/reconnect behavior, memory bounds and a disposable restore drill with recovery targets. |
| REL-06 | Full candidate verification and hosted CI not established. | Full checks remain paused at the user's request. Before release, run the agreed candidate suites and observe the hosted workflow. Historical or focused local passes are not a green release pipeline. |

### Most recent focused verification (historical results, not rerun here)

- Media/waveform unit regressions: **18 passed**; `/tmp/conclave-reuse-unit.log`.
- Focused desktop/mobile browser checks: **6 passed**; `/tmp/conclave-reuse-browser.log`. They ran before the last Blob-identity adjustment; that adjustment has a dedicated unit regression.
- Client production build: **passed**, 38.86 seconds; `/tmp/conclave-reuse-build.log`.
- These do not cover every screen or substitute for live acceptance. This documentation update only requires Markdown/link review and `git diff --check`; no application tests were rerun.

## Reference patterns and scope boundaries

- [WhatsApp voice playback](https://faq.whatsapp.com/1165411581043811/?cms_platform=web): compact controls and playback continuity are useful references. Playback beyond the current chat is optional later work, not an unapproved launch requirement.
- [Slack sidebar organization](https://slack.com/help/articles/212596808-Adjust-your-sidebar-preferences): use grouped navigation and clear conversation/work destinations rather than copying Slack's whole layout.
- [Discord mobile navigation](https://support.discord.com/hc/en-us/articles/40953848660759-You-Bar-FAQ): use predictable primary navigation and clear nested-screen return paths.
- Preserve Conclave's theme, functionality, access control, file validation and user-selected hover rail. This is not authorization to replace the application shell or remove useful explanations, errors or legal disclosures.
- Moderation tooling, quotas, malware scanning, OS notification actions, recurring quiet hours, global-search expansion, calling, call history and room events remain governed by [DEFERRED_FEATURES.md](docs/DEFERRED_FEATURES.md). Existing scoped work search is not evidence that full cross-room message search is implemented.

## Recommended implementation order

UI-01–14 were completed or source-verified on 24 November 2026. Continue with the explicitly tracked live provider, physical-device, load, backup and hosted-CI release gates before public launch.

### UI-11–14 implementation verification — 24 November 2026

- UI-11, UI-12 and UI-13 each passed a production build before work advanced to the next item.
- Final client unit suite after UI-14: **112 passed**.
- Final client production build: **passed** in 25.22 seconds.
- Light theme minimum measured text contrast on canvas/surface: muted **4.61:1**, semantic **4.55:1**, brand **5.81:1**, primary ink **15.03:1**.
- Dark theme minimum measured text contrast on canvas/surface: muted **6.87:1**, semantic/brand **5.73:1**, primary ink **14.82:1**.
- Dark filled-brand controls with white text: **5.45:1** after correction; shared brand focus outlines: at least **5.73:1** against app surfaces.
- Reduced-motion disables animation, transitions and smooth scrolling globally; chat timeline and media viewer also retain their targeted reduced-motion handling.
- Diff checks passed and no merge-conflict markers were found.
- Playwright was not run under the user's standing instruction. Browser zoom/reflow, screen-reader and physical-device results remain part of REL-03 and are not represented as completed live acceptance.

### UI-04–10 implementation verification — 24 November 2026

- Each UI item was completed in order and followed by a successful client production build: **7 builds passed**.
- Final client unit suite: **112 passed**.
- Final client production build: **passed** in 22.57 seconds.
- Staged and unstaged diff checks passed, with no merge-conflict markers found.
- Playwright was intentionally not run for UI-04–10 at the user's request. Browser and hosted CI status remain unclaimed.
- Existing Vite warnings about modules imported both statically and dynamically are informational and unchanged.

### UI-01–03 implementation verification — 24 November 2026

- Backend unit suite: **48 passed**.
- Focused disposable-database regressions for full-scope task totals, assigned filtering across pages and decision-scoped totals: **2 passed**.
- Client unit suite: **22 test files passed**.
- Client production build: **passed**. Existing Vite dynamic/static import warnings remain informational.
- UI-01 focused Playwright mobile regression: **1 passed** before browser checks were paused.
- UI-02 focused mobile regression is present but was not run after the user asked to pause Playwright. Full browser/CI status remains unclaimed.

## Historical implementation follow-up — 23 November 2026

The previous follow-up recorded that push previews/grouping/icons, the app badge,
in-app toast/sound, drag-and-drop through composer validation, gallery navigation
and upload queues were already implemented. Former message E2EE was removed by
migration 061; its device keys and encryption-review tasks are retired.

That work also covered dependency patches, shared socket limits, toast
interaction, hidden-tab suppression and authenticated accessibility. These
historical implementation notes do not replace the current release evidence or
prove live acceptance. New functionality remains tracked in
[deferred feature designs](docs/DEFERRED_FEATURES.md).

## Historical notification/media analysis — superseded

The original notes below are retained for provenance. They are **not a current defect list**. In particular, their claims about missing badge, notifications, drag-and-drop, queues and gallery navigation were corrected by later inspection/implementation. Do not use the old priority order as the current plan.

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
