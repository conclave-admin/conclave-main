# Message E2EE removal tracker

Existing encrypted conversations and associated data are to be purged. Preserve JWT, bcrypt, token hashing, signed R2 previews, preview Worker HMAC, VAPID push, and mail-queue AES-GCM.

- [x] Backend: team routes, sockets, account/session cleanup, uploads, and V1/V2 services and routes.
- [x] Client: lifecycle, settings, encrypted screens, crypto and vault code, and messaging and team branches.
- [x] Migration: validate purge, foreign keys, triggers, storage cleanup, and preservation of unrelated data.
- [x] Supporting files: remove E2EE-only dependencies and artifacts; update tests, CI, and docs while retaining unrelated coverage.
- [x] Verify migrations, backend and client tests, production build, and relevant browser flows.

Progress:
- Removed encryption-mode branches in team routes, socket message input, account deletion, and encrypted upload handling. Retired V1/V2 backend routes, services, validation, scripts, dependencies, and E2EE-only backend tests were removed; non-E2EE security tests remain.
- Removed client encryption screens, runtime modules, settings, messaging and storage branches, and E2EE-only dependencies. Preserved public-computer session coverage. Client unit tests pass (84), the production build passes, and the thread browser check passes.
- Populated migration regression passes: V1/V2 rooms and MLS grants, uploaded and attached media, unclaimed uploads, unrelated and archived mixed teams, shared objects, encrypted mail, rollback/retry, foreign keys and restored triggers. It exercises storage cleanup with a mocked provider. The full backend database suite passes (263 tests), including fresh migration and rerun checks.
- Browser verification uses installed system Chrome because Playwright's bundled Chromium is absent. Messaging quality flows pass on desktop and mobile after aligning stale preview expectations with the current UI; recovery access flows pass 38/38, including the desktop/mobile removal navigation check; retained security regressions pass 12/12.
- Confirmed both previously inaccessible MLS build caches under `client/crypto/mls/target` and `prototypes/encryption-v2/mls-rs-proof/target` have been removed.
- Supporting-file cleanup: E2EE-specific browser configs, tracked prototype files, reports, and dependencies were removed; the mixed security suite was retained and renamed. All 12 retained desktop/mobile browser cases passed across targeted runs, and the reading-position regression they exposed was fixed.
- Backend unit tests pass (39); the database suite passes (263) on Node 22 after removing the obsolete encryption fixture and E2EE-only tests. Separate database-backed message and team cutover regressions also pass. Client unit tests pass (84), and the production build passes with Vite warnings only.
- Final verification: migration fresh apply, rerun, populated purge, rollback, foreign keys, triggers, and storage cleanup pass; backend unit and database suites pass; client tests and production build pass; messaging, recovery, and retained security browser suites pass on desktop and mobile.

The current migration and partial application changes are not ready to deploy.
