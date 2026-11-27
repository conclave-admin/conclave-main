# Release evidence and blockers

The minimum invite-only release gate is tracked in
[Controlled beta readiness](BETA_READINESS.md).

## Candidate

- Assessment date: 23 November 2026 (Africa/Lagos).
- Base commit: `d896b93`; current fixes are uncommitted working-tree changes.
- Runtime: Node 22.23.4, npm 10.9.9, Linux.
- Datastores: local PostgreSQL 16 and Redis 7; tests create uniquely named
  disposable databases. Production data and deployment were not changed.
- Migration policy: tests apply the complete historical chain to fresh disposable
  databases and verify rerun behavior. No deployment migration was performed.
- Storage/email in automated browser checks: mocked, not live-provider proof.

## Local evidence


### Account controls and notification setup — 27 November 2026

- Branch: `fix/account-notification-polish`, based on `cac4d4b`.
- Added accessible show/hide controls to login and signup passwords. Signup
  rejects mismatched confirmation before registration, focuses the confirmation
  input, and keeps confirmation out of the API payload.
- Added an opaque, theme-aware surface behind the empty-conversation text and
  actions. Reviewed desktop dark-theme and narrow-screen signup screenshots.
- Repaired push setup after an initial configuration outage, overlapping setup
  requests, restricted preference storage, and rejected permission prompts.
  Browser opt-out choices survive storage restrictions for the current tab and
  synchronize across tabs when storage is available.
- Added HTTPS and iPhone/iPad Home Screen guidance and a retry path when server
  push configuration is unavailable. Each device still requires its own grant.
  Apple's platform requirements:
  https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Node 22.23.4: client unit tests **119 passed**, backend unit tests **61 passed**;
  production client build passed (existing bundle-size advisory remains).
- Complete desktop/mobile recovery suite: **74 passed**, including 14 new
  account/notification checks; included in CI.
  The notification setup tests use a mocked push transport; they do not prove
  delivery through FCM, Mozilla, or Apple.
- Live installed-PWA delivery remains pending: confirm the affected operating
  system and browser, device permission/Focus settings, and foreground,
  background and closed-app delivery with a real subscription. No production
  provider settings or deployment were changed.
- Hosted CI results belong to the PR/run for this branch; local checks alone
  must not be reported as successful hosted CI.


### CI failure repair — 26 November 2026

- Investigated the supplied hosted logs from 11:41 UTC. The pull-request backend
  job checked the synthetic merge of `5ac0c2d` into `dcd9547`; the push backend
  job passed because it checked the branch without those main-branch changes.
- Reconciled `origin/main` locally without committing. Restored the work inbox
  state and automation controller exports required by `work.routes.js` and kept
  `toLowerCase()` in search scoring. Main's deleted exports caused Express to
  fail during startup with an undefined PATCH callback; its `toLower()` would
  also fail when search returned results. Work routes now have explicit smoke
  coverage. Main's migration changes are included in this merged candidate.
- Fixed the lazy Settings import regression to wait for the intercepted request
  using an auto-retrying assertion. A route URL update does not guarantee that
  the browser has dispatched the module request. The request remains blocked
  while the test checks that the main element and shell stay mounted.
- Backend unit checks passed: 59/59, including the expanded route checklist.
- Complete database checks passed: 301/301 against disposable local PostgreSQL
  and Redis, including the merged migration chain and migration rerun check.
- Release browser regressions passed: 36/36 under `CI=true`, with three repeats
  on each desktop/mobile project. No assertions, timeouts, or skips were relaxed.
- Commit `da7667c` passed the hosted backend and client jobs. Both hosted
  browser jobs passed recovery, then failed security at account registration:
  the disposable API inherited missing JWT secrets on the clean runner.

### Clean-runner security fixture repair — 26 November 2026

- The security browser server now generates fresh access, refresh, and mail
  encryption keys for its disposable API. Its browser origins, signup cohort,
  proxy trust, and provider switches are explicit. It no longer depends on a
  developer `.env` or production secrets for authentication.
- Signup fixtures use distinct randomized client addresses and account names
  across worker restarts, retaining the real signup limiter and unique-name
  policy. No production rate limit, authentication behavior, assertion, timeout,
  or skip was relaxed.
- Backend unit checks passed: 61/61, including token issuance without environment
  secrets and isolation from conflicting developer settings.
- Real-API security browser checks passed: 12/12 desktop/mobile with `CI=true`,
  blank JWT/mail keys, a conflicting origin, and signups disabled in the parent
  environment. The disposable API overrides those inputs; `/tmp/conclave-security-clean-env.log`.
- Hosted verification will first run the candidate on a temporary CI branch;
  the same commit can then update `branch-michael` after a successful run.

The older results below are historical and describe the 23 November candidate.

Further CI/browser verification was paused at the user’s request on 23 November
2026. The results below record completed work; pending and failed checks remain
unresolved. No hosted CI pass or deployment readiness is claimed.

Update this table for each candidate; include counts, skips and failure reasons.
Temporary log paths below are local debugging aids, not retained CI artifacts.

| Check | Result | Evidence |
| --- | --- | --- |
| Backend unit | Passed, 43 tests | `/tmp/conclave-backend-unit-final.log` |
| Client unit | Passed, 100 tests | `/tmp/conclave-check-final.log` |
| Client production build | Passed after final dependency update, Vite 6.4.6 | Import/chunk warnings remain; `/tmp/conclave-check-final.log` |
| Fresh migrations and rerun | Passed against disposable databases | `/tmp/conclave-db-ci.log` |
| Complete database suite | Passed, 259 tests and 6 credential-gated skips in the CI-equivalent environment | `/tmp/conclave-db-ci.log`; live provider cases exercised separately |
| Recovery and release browser regressions | Passed, 48/48 before final Playwright update; final runner rerun paused | Desktop/mobile Chromium; `/tmp/conclave-recovery.log` |
| Real-API security browser suite | Not yet green: latest fail-fast run hit existing workflow deadline; earlier run 10/12 passed | Disposable DB, real Redis, mocked storage/email; `/tmp/conclave-security-final.log` |
| Media/messaging regression browser suite | Not yet green; stale video-label assertions corrected, album fixture timeout unresolved; further runs paused | Mocked transport; `/tmp/conclave-media-final.log`, `/tmp/conclave-media-artifacts` |
| Dependency audits | Passed, zero vulnerabilities in both packages | Clean reinstall audits; `/tmp/conclave-backend-ci-final.log`, `/tmp/conclave-client-ci.log` |
| Clean dependency reinstall | Passed for backend and client | Both lockfiles; obsolete crypto packages removed |
| Live R2 API suite | Passed, 21/21 in isolated rerun | `/tmp/conclave-r2-final.log`; earlier multipart network failure remains recorded |
| Hosted GitHub Actions | Pending candidate commit/push | Local changes have no hosted run |

## Dependency and compatibility notes

- Local rooms-500 repair, 23 November 2026: the configured development database
  recorded migration 063 but lacked `rooms.superseded_by` (SQLSTATE 42703).
  Forward migration 064 restores the nullable UUID self-reference without
  changing existing links. Its focused temporary-table regression passed,
  including rerun preservation and foreign-key enforcement. Only 064 was
  pending and it was applied to the confirmed local database; the exact rooms
  SELECT then succeeded and returned three rooms. No production migration was
  run; the full suites and hosted CI remain paused.

- React Router 7.18.6 replaces 6.x; no optional migration flags were enabled.
  Browser checks cover nested chat routes, notification click-through, history,
  reload/deep links, auth/session recovery and same-origin navigation.
- Express remains on 4.x; Multer is 2.5.0, body-parser 1.20.9, qs 6.16.2 and
  follow-redirects 1.16.3. Lockfiles contain the audited resolutions.
- Playwright is updated to 1.65.1 while investigating local trace-artifact failures; traces and original assertion timeouts remain enabled.
- Vite 6.4.6 retains the existing bundler and compatible React plugin. Nodemon
  is deliberately pinned to 3.1.11: newer 3.1.14 depends on the advisory-affected
  minimatch 10 line, while this release resolves patched minimatch 3.1.5.
- Apart from the local schema-drift repair in migration 064, no application
  schema/API migration is introduced by these fixes. Shared
  socket limits require healthy Redis in production and return retryable 503s
  on store failures; stop activity remains possible after a start flood.

## Release blockers and external acceptance

Do not mark an item complete without dated evidence, environment/build identity,
expected/observed behavior and sanitized provider/device results.

- [ ] Live push: FCM/Mozilla delivery, closed/background app, grouping, click
  navigation, preview opt-out, mute/DND, expired subscriptions and logout.
- [ ] Live Resend: verified sending-domain evidence, verification and recovery
  inbox delivery, token expiry/single use, retries/idempotency and session revocation.
  Historical notes record user-reported local recovery delivery; that is not
  deployed end-to-end acceptance.
- [ ] R2: API upload/download round trips passed in the database suite. Bucket CORS, multipart abort lifecycle, preview Worker signing/bindings,
  authorized Range/download/transfer and revoke tests against the real bucket.
- [ ] Deployed HTTPS and physical devices: supported browser/device matrix,
  keyboard/composer layout, background/sleep/reconnect and accessibility review.
- [ ] Sustained load, network interruption, large-history and media-session memory:
  record workload, latency/error/memory targets, results and remediation.
- [ ] Backup restore drill: disposable restore, integrity, recovery point/time and
  operator sign-off. Never test restores by overwriting a live database.
- [ ] Privacy/terms operator fields: approved legal entity, contacts, regions,
  retention and venue values supplied by the operator.
- [ ] Moderation readiness: platform-moderator triage and enforcement remain
  deferred; record the release decision explicitly rather than implying reports
  are operationally reviewed.
- [ ] Hosted CI: link successful candidate workflow after committing/pushing.

Deferred product work, including storage quotas, is specified in
[DEFERRED_FEATURES.md](DEFERRED_FEATURES.md).

## Repeatable verification

Use Node 22, install backend/client dependencies with `npm ci`, then run root
`npm run check`, `npm run test:db`, `npm run test:browser` and `npm run test:media`.
Use local disposable-test PostgreSQL/Redis credentials. Install Chromium first.
Audit both packages with `npm audit --audit-level=moderate`. Migration of a real
application database is a separate explicit `npm run migrate` operation.

CI runs units/build, dependency audits, fresh/rerun migrations, database checks,
recovery/release/security browser checks and media regressions. CI uploads failed
browser traces/screenshots. Passing CI does not resolve the external checks above.

## Messaging UI follow-up — 23 November 2026

Implemented the five requested UI areas; see [messaging UI](MESSAGING_UI.md).
Local production builds passed (`/tmp/conclave-ui-build.log` and
`/tmp/conclave-ui-build-final.log`), with the existing bundler warnings.
Fixture previews were inspected at 1440×960 and 390×844 in light/dark modes;
chat and settings checks reported no horizontal document overflow. A read-only
local rooms-controller check returned 200 and three rooms, including a real
own-message receipt summary. All eight new desktop/mobile messaging-layout
regressions passed (`/tmp/conclave-ui-regressions.log`, 50.8 seconds), including
composer voice/send switching, mention insertion/focus, per-bubble timestamps
and real receipt rendering, rail overlap, density, settings focus and dark mode.
Separate fixture interaction checks passed shared-gallery opening and next-item
navigation with no page errors, plus multi-file staging, the stable upload-dialog
name, selected-file count, caption retention and removal. The final production
build passed after the last changes (52.97 seconds). The eight automated layout
cases are wired into the recovery configuration; gallery/staging checks above
were focused local browser interactions, not new full-suite runs. Broad CI/security/media suites remain paused; earlier
suite counts predate these UI changes and do not validate them.

## Compact media follow-up — 23 November 2026

The oversized album shown in the user screenshot is replaced with a bounded
collage, four-tile/+N overflow, in-photo upload controls and improved staging.
See [messaging UI](MESSAGING_UI.md) for behavior and the Superdesign canvas.
The user explicitly approved publishing the authored draft and existing logo;
the saved draft was fetched and verified at version 1. No paid generation,
repository-source upload, production access or deployment was performed.

- Affected album/staging matrix: **12/12 passed**, desktop and mobile,
  `/tmp/conclave-whatsapp-media-tests.log` (3.2 minutes). Includes existing
  multipart resume, swipe, caption and reduced-motion cases plus five-photo
  cropping/overflow/jump and append-files/caption-retention regressions.
- Receipt/read policy: **7/7 passed**, `/tmp/conclave-media-reads.log`, including
  explicit viewer opt-in and rejection of background, unfocused, offline,
  unrelated or nested modal contexts.
- Local screenshot check: five files render as four visible tiles, desktop
  width 360px, no mobile horizontal overflow, full viewer navigation and source
  jumps. Screenshots: `/tmp/conclave-whatsapp-album-desktop.png` and
  `/tmp/conclave-whatsapp-album-mobile.png`.
- Photo/video cache and thumbnail/poster checks: **6/6 passed**, desktop/mobile,
  `/tmp/conclave-media-cache-regressions.log` (1.7 minutes).
- Final stricter offline/retry checks: **4/4 passed**, desktop/mobile,
  `/tmp/conclave-media-cache-final.log` (1.3 minutes). These repeat the photo/video
  subset with explicit persisted-offline assertions; they are not four additional
  unique cases. Visual success labels were replaced by semantic persisted-state
  assertions, preserving the original offline guarantee and request-count checks.
- The production build passed after the viewer/control compatibility additions
  (`/tmp/conclave-media-redesign-build-final.log`, 1m44s). The final build after
  the offline-state attribute addition also **passed** (1m19s), recorded in
  `/tmp/conclave-whatsapp-final-build.log`. Temporary fixture-preview server 5193
  was stopped after verification; the normal application server was left alone.
  Full CI and live-provider/device acceptance remain paused.

## Unresolved verification issues

Navigation flicker follow-up: removed the sidebar-triggered main-element key
that remounted the route subtree, and bounded lazy-route loading inside the
main content and conversation panes. Removed the obsolete sidebar page-enter
animation. A delayed-module browser regression checks shell/main identity and
visibility through navigation. This follow-up has not been browser-verified;
CI/browser execution remains paused by user request. Earlier build/test results
predate this follow-up and must not be treated as validation of it.

The local host reached approximately 236–570 MB available RAM with all 4 GB of
swap occupied during browser checks. Existing security workflows timed out;
individual reading-position checks passed when isolated. Further checks are paused by user request; these failures are not waived. The
suite must pass before security browser acceptance is complete.

The voice fixture now waits for authenticated composer readiness and observes
fresh playback events in-browser. Short clips reset currentTime when ended;
runner polling could miss their progress. Offline checks require new progress
after each offline transition, retaining the original thresholds and timeouts.

## Candidate closeout

- [ ] Record final commit and CI URL, date, counts, skips and artifacts.
- [ ] Review unresolved blockers and assign an owner and explicit release decision.
- [ ] Re-run affected checks after subsequent changes; retain evidence with the release.

## Social messaging UI follow-up — 23 November 2026

Environment: local Linux, Node 22.23.4, Chromium through Playwright 1.65.1.
Working-tree changes only; no new commit, push, deployment, production migration
or hosted CI result is associated with this follow-up. The user's staged
`fix.md` edits remain unchanged (30 additions / 21 deletions).

- Focused mention/profile unit checks: **5/5 passed**. Log:
  `/tmp/conclave-profile-unit-final.log`. These cover recorded IDs, names with
  spaces, ambiguous names, email/partial-name exclusions, profile scope and
  privacy query constraints, and the common unavailable-profile response.
  They do not replace database or live acceptance testing.
- Production client build: **passed**, 1m 27s. Log:
  `/tmp/conclave-social-build.log`.
- Existing media album suite after the viewer redesign: **12/12 passed** on
  desktop/mobile in `/tmp/conclave-social-browser.log`; the same run exposed
  three failures in new tests. The preview service's directory/member record
  priority was corrected, and the rail test now establishes pointer position
  after navigation. Final focused six social UI checks then **6/6 passed**:
  `/tmp/conclave-social-six-final.log`.
- Final combined affected-screen checks after mobile name wrapping, preview
  scaling and copy cleanup: **12/12 passed** across desktop/mobile (2.0m).
  Log: `/tmp/conclave-social-complete.log`. Covers viewer zoom/navigation/jump,
  chat row density and rail overlap, dark settings/focus, real mention links,
  member-name width, media-section focus, own-profile controls and overflow.
  Used `/tmp/conclave-social-final.config.mjs` to select affected suites only.
- Inspected local screenshots include the member profile, room-info overview,
  gallery, settings and dark media viewer. The viewer capture uses the existing
  Conclave landing image as fixture media, not live user uploads. Early mobile
  captures exposed a small loading preview and member-name truncation; both
  were corrected before the final checks.
- New social UI regressions are included in `playwright.media-regression.config.js`
  for future CI. Existing responsive-header and rail-overlap assertions now
  check the requested desktop hover behavior and mobile-only menu.
- Superdesign draft `77e104af-7f07-4e4e-8bba-dabeb9118927`, version **2**, was
  fetched after direct import and its ID/version/content verified. The approved
  existing logo is reused. No paid generation was used.

Broad CI remains paused at the user's request. No claim is made that all suites
or hosted CI pass. Live R2, push, email, physical-device, load and backup-restore
acceptance remain pending as previously recorded.

## Hybrid voice notes and quiet downloads — 23 November 2026

Scope: client/UI and browser cache only; no dependency, backend, database,
provider, production or deployment changes. User selected hybrid recording,
automatic media downloads and IndexedDB retention. Existing explicit per-device
preferences and Data Saver/network restrictions are retained. Background work
continues across navigation while Conclave is open; no OS-level download service
is claimed after the browser closes.

- Node 22.23.4 / Chromium through Playwright 1.65.1 on local Linux.
- Focused unit regressions: **16/16 passed** in
  `/tmp/conclave-voice-unit-final.log`. Covers real waveform peak sampling,
  gesture thresholds, per-type defaults, two-transfer background concurrency,
  navigation survival, manual promotion without duplication, cancellation,
  account-scoped clearing and prevention of late cache writes.
- New desktop/mobile browser matrix: **10/10 reported passed** (3.4m), log
  `/tmp/conclave-voice-browser-final.log`. Covers tap/pause/resume/preview,
  hold/cancel/lock, offline voice queuing, silent original downloads, offline
  image/document/audio reuse after reloading, and retention beyond the
  disposable cache budget. The execution wrapper subsequently reported signal
  exit 143; this test report alone is not treated as a clean process exit.
- Initial checks found and corrected a Stop-click suppression bug, dev-fixture
  navigation readiness before cutting the network, and photo metadata
  intercepting image taps. Existing manual-download assertions were updated
  to inspect actual cache availability instead of removed helper text.
- Final affected-screen rerun: **8/8 passed**, clean process exit 0 (1.8m),
  `/tmp/conclave-voice-final-affected.log`. Includes visible-only/serialized
  waveform decoding, real mobile touchscreen tap, quiet offline media reuse,
  document cache clearing, and existing album zoom/navigation/source jumps.
- Final gesture/interruption rerun: **6/6 passed**, clean process exit 0 (1.3m),
  `/tmp/conclave-voice-interruptions.log`. Covers hold/cancel/lock, offline
  hold-to-send, stopping into preview on blur with late-release suppression,
  and subsequent keyboard-only recording/preview on desktop/mobile.
- Final production build: **passed**, clean process exit 0 (47.65s),
  `/tmp/conclave-voice-final-build.log`. No full CI run is implied by these
  targeted local checks.
- Superdesign draft `4fe622a0-b49c-4fe0-b7db-6e62dee2b95d`, version **1**,
  was fetched and verified after free direct import. Existing approved logo
  reused; no paid generation. Actual screenshots are local test captures,
  not evidence of live-provider acceptance.

The new `voice-offline.spec.js` is included in the media regression configuration
for future CI. Existing security-preview assertions now verify the visible
custom player and attached audio engine rather than native controls; the full
security suite is not claimed as rerun. Broad/hosted CI remains paused. Physical
microphone/device acceptance, browser eviction behavior under real storage
pressure, and live R2/provider checks remain pending.

### Production UI copy cleanup — 2026-11-23

- Removed transient offline-save/completed-download announcements from attachment cards and the media viewer; automatic downloads remain quiet. Manual progress, cancellation, errors and retry actions remain available.
- Removed duplicate hidden gallery captions and redundant catch-up guidance. Retained meaningful accessible control labels, skip navigation, upload progress and read confirmations. Simplified timeline announcements to the latest sender.
- Corrected the privacy page’s obsolete Cloudinary-only storage description. Privacy/terms operator details are still launch blockers; their draft disclosure remains visible.
- Node 22: six focused Playwright checks passed across desktop/mobile (59.3 s): photo download and offline reopening, manual document download/cache clearing, quiet automatic image/document/audio downloads and offline use. Log: `/tmp/conclave-production-copy-browser.log`.
- Client production build passed (25.87 s), log `/tmp/conclave-production-copy-build.log`. Full CI and hosted CI remain paused/unverified. The subsequent source changes were copy-only (privacy provider wording and timeline announcement); the build includes them.

### Media reuse and transfer UI — 2026-11-23

- Removed download progress bars/percentages from attachment cards and the fullscreen viewer; retained upload progress, cancellation and retry behavior.
- Added immediate loaded-Blob reuse and preserved Blob identity during IndexedDB rechecks, including usable memory copies when persistence fails. Explicit invalidation and session cleanup remain effective.
- Node 22 focused media/waveform unit tests: 18 passed (`--experimental-test-isolation=none`), log `/tmp/conclave-reuse-unit.log`.
- Desktop/mobile media browser regressions: 6 passed (53.1 s), log `/tmp/conclave-reuse-browser.log`; covers offline image reopening, repeated voice playback, no viewer progress bars, request counts, manual documents and cache clearing. These ran before the final Blob-identity adjustment, which is covered by the added unit regression.
- Full/hosted CI remains paused. Browser storage eviction/clearing can still require a later network fetch; no browser can guarantee permanent retention.
- Client production build passed (38.86 s), log `/tmp/conclave-reuse-build.log`; `git diff --check` passed.
