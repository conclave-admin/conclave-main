# Large-chat performance (GH-20)

The local preview includes `preview-large-room`: 1,200 messages, 51 photos,
30 documents, a 7,500-character message, and a reply to an earlier photo.
This fixture is generated only when opened. The normal chat preview is small.

## Desktop baseline

Measured in headless Chromium on 26 October 2026, using the dev build and
`CONCLAVE_PERF_BASELINE=1 npx playwright test e2e/large-chat.spec.js
--project=app-desktop --grep 'manual full-render'` from `client/`. The manual
`?fullHistory=1` route renders all rows for comparison. The script opens that
route first, then the windowed route in the same browser. The second navigation
can benefit from warm code and media caches. These are local measurements, not
production latency targets. The measurements were taken before the later
thread-count request optimization, so they isolate the timeline change more
closely than the final implementation's total load time.

| Measurement                             | Full render | Windowed render |
| --------------------------------------- | ----------: | --------------: |
| Mounted message rows after scroll sweep |       1,200 |              13 |
| DOM nodes                               |     114,267 |           2,614 |
| JS heap after forced garbage collection |    109.3 MB |         14.1 MB |
| Navigation to mounted rows              |      39.0 s |          12.2 s |
| 20-position scroll sweep                |      38.2 s |           6.2 s |

The browser's ordinary `performance.memory` value was identical in both
samples, so the heap comparison uses Chrome DevTools Protocol's
`JSHeapUsedSize` after garbage collection. Timing varies with machine load and
the second navigation's warm caches. Repeat the command on the target devices
before setting release budgets.

## Implementation and checks

The timeline mounts only groups near the viewport once a conversation exceeds
80 groups. It measures rendered group heights and uses spacers for the rest.
Reply and pin jumps first materialize their target, then scroll to and highlight
the message. Scroll position is retained when older history is prepended or a
reader returns to an anchored conversation. Read receipts continue to scan
visible rows. Unmounted image components revoke their object URLs and abort
unfinished preview requests. The existing IndexedDB history cache keeps the
latest 200 confirmed messages per room; full conversation metadata remains in
memory while that room is open so search, jumps, and media navigation can work.
The room memoizes its timeline payload and requests thread counts only for new
or changed roots. Receipt reconciliation uses a map lookup instead of scanning
the whole loaded history once per message.

The desktop and mobile `large-chat.spec.js` interaction check passed with
fewer than 80 mounted messages, reply and pin jumps, return to latest, object URL
cleanup, reload at the saved position, and no page-level horizontal overflow.
The existing `messaging-quality.spec.js` covers long text and reply composer
overflow at mobile width. A physical low-memory device and deployed server
load remain separate release checks.
