# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: visual.spec.js >> static-audit suspicions, measured >> A3 — "Jump to latest" is inside the viewport when it is showing
- Location: e2e/visual.spec.js:321:3

# Error details

```
Error: pill is rendered outside the visible pane

expect(received).toBe(expected) // Object.is equality

Expected: false
Received: true
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - link "CONCLAVE" [ref=e6] [cursor=pointer]:
        - /url: /chats
      - paragraph [ref=e7]: Workspace
      - navigation [ref=e8]:
        - link "Chats 3" [ref=e9] [cursor=pointer]:
          - /url: /chats
          - generic [ref=e13]: Chats
          - generic [ref=e14]: "3"
        - link "Decisions" [ref=e15] [cursor=pointer]:
          - /url: /decisions
        - link "Tasks" [ref=e20] [cursor=pointer]:
          - /url: /tasks
        - link "Digest" [ref=e25] [cursor=pointer]:
          - /url: /digest
        - link "Notifications 2" [ref=e30] [cursor=pointer]:
          - /url: /notifications
          - generic [ref=e33]: Notifications
          - generic [ref=e34]: "2"
      - paragraph [ref=e35]: Rooms
      - navigation [ref=e36]:
        - link "Victor" [ref=e37] [cursor=pointer]:
          - /url: /chats/preview-dm
          - generic [aria-hidden] [ref=e38]: V
        - link "Product & Engineering 3" [ref=e40] [cursor=pointer]:
          - /url: /chats/preview-room
          - generic [ref=e44]: Product & Engineering
          - generic [ref=e45]: "3"
      - generic [ref=e46]:
        - link "Amina Yusuf Available" [ref=e48] [cursor=pointer]:
          - /url: /profile
          - generic [ref=e50]:
            - generic [ref=e51]: Amina Yusuf
            - generic [ref=e52]: Available
        - link "Invite members" [ref=e55] [cursor=pointer]:
          - /url: /new
        - link "Settings" [ref=e59] [cursor=pointer]:
          - /url: /settings
  - generic [ref=e65]:
    - banner [ref=e66]:
      - navigation [ref=e67]:
        - paragraph [ref=e68]:
          - generic [ref=e69]:
            - generic [ref=e70]:
              - heading "Product & Engineering" [level=1] [ref=e72]
              - paragraph [ref=e73]: 4 members
            - link "Room information" [ref=e74] [cursor=pointer]:
              - /url: /chats/preview-room/info
        - generic [ref=e78]:
          - generic [ref=e79]:
            - generic [ref=e80]: Search chats
            - searchbox "Search chats" [ref=e81]
          - link "Notifications, 2 unread" [ref=e82] [cursor=pointer]:
            - /url: /notifications
            - generic [ref=e85]: "2"
    - main [ref=e86]:
      - generic [ref=e87]:
        - generic [ref=e89]:
          - generic [ref=e91]:
            - button "All" [pressed] [ref=e92] [cursor=pointer]
            - button "Unread" [ref=e93] [cursor=pointer]
            - button "Groups" [ref=e94] [cursor=pointer]
            - button "DMs" [ref=e95] [cursor=pointer]
          - link "2 things to catch up on 1 decision 1 task" [ref=e96] [cursor=pointer]:
            - /url: /digest
            - generic [ref=e97]:
              - generic [ref=e98]: 2 things to catch up on
              - generic [ref=e99]:
                - generic [ref=e100]: 1 decision
                - generic [ref=e104]: 1 task
          - list [ref=e111]:
            - listitem [ref=e112]:
              - link "Victor Oct 8 Sending the deck over now." [ref=e113] [cursor=pointer]:
                - /url: /chats/preview-dm
                - generic [aria-hidden] [ref=e114]: V
                - generic [ref=e115]:
                  - generic [ref=e116]:
                    - generic [ref=e117]: Victor
                    - generic [ref=e118]: Oct 8
                  - generic [ref=e119]: Sending the deck over now.
              - button "Actions for Victor" [ref=e121] [cursor=pointer]
            - listitem [ref=e126]:
              - link "Product & Engineering Oct 8 On it—validating the config and update by EOD. 3" [ref=e127] [cursor=pointer]:
                - /url: /chats/preview-room
                - generic [aria-hidden] [ref=e128]: P&
                - generic [ref=e129]:
                  - generic [ref=e130]:
                    - generic [ref=e131]: Product & Engineering
                    - generic [ref=e132]: Oct 8
                  - generic [ref=e133]:
                    - generic [ref=e134]: On it—validating the config and update by EOD.
                    - generic [ref=e135]: "3"
              - button "Actions for Product & Engineering" [ref=e137] [cursor=pointer]
        - generic [ref=e143]:
          - generic [ref=e145]:
            - generic [ref=e146]: Pinned
            - list [ref=e147]:
              - listitem [ref=e148]:
                - generic [ref=e149]:
                  - link "Use Socket.IO for real-time events; REST handles CRUD." [ref=e152] [cursor=pointer]:
                    - /url: /decisions/dev-decision-1
                  - generic [ref=e153]: Pinned to the room by Amina Yusuf
                  - button "Pin actions for Use Socket.IO for real-time events; REST handles CRUD." [ref=e154] [cursor=pointer]
          - generic [ref=e160]:
            - separator "August 27" [ref=e161]
            - article [ref=e166]:
              - generic [ref=e167]:
                - generic [ref=e168]:
                  - generic [ref=e169]: You
                  - time [ref=e170]: 10:07 AM
                - generic [ref=e171]: After testing both approaches, we'll keep Socket.IO for real-time events and REST for CRUD.
                - generic [ref=e172]:
                  - button "👍 reaction, 2" [pressed] [ref=e173] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e174]: 👍
                    - generic [ref=e175]: "2"
                  - button "🎉 reaction, 1" [ref=e176] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e177]: 🎉
                    - generic [ref=e178]: "1"
                  - button "Add a reaction" [ref=e179] [cursor=pointer]
                - generic [ref=e185]: Read
              - button "Message actions" [ref=e192] [cursor=pointer]
            - article [ref=e198]:
              - generic [aria-hidden] [ref=e200]: V
              - generic [ref=e202]:
                - generic [ref=e203]:
                  - generic [ref=e204]: Victor
                  - time [ref=e205]: 10:17 AM
                - generic [ref=e206]: Sounds good. This keeps our real-time path focused and reduces operational overhead.
                - button "Add a reaction" [ref=e208] [cursor=pointer]
              - button "Message actions" [ref=e216] [cursor=pointer]
            - article [ref=e222]:
              - generic [ref=e223]:
                - generic [ref=e224]:
                  - generic [ref=e225]: You
                  - time [ref=e226]: 10:27 AM
                - generic [ref=e227]: "@Priya can you confirm deployment readiness for the API gateway changes today?"
                - generic [ref=e228]: edited
                - button "Add a reaction" [ref=e230] [cursor=pointer]
                - generic [ref=e236]: Read
              - button "Message actions" [ref=e243] [cursor=pointer]
            - article [ref=e249]:
              - generic [aria-hidden] [ref=e251]: P
              - generic [ref=e253]:
                - generic [ref=e254]:
                  - generic [ref=e255]: Priya
                  - time [ref=e256]: 10:37 AM
                - generic [ref=e257]: "Replying to Amina Yusuf: @Priya can you confirm deployment readiness for the API gateway changes today?"
                - generic [ref=e258]: On it—validating the config and will update here by EOD.
                - generic [ref=e259]:
                  - button "✅ reaction, 1" [ref=e260] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e261]: ✅
                    - generic [ref=e262]: "1"
                  - button "Add a reaction" [ref=e263] [cursor=pointer]
              - button "Message actions" [ref=e271] [cursor=pointer]
            - article [ref=e277]:
              - generic [aria-hidden] [ref=e279]: V
              - generic [ref=e281]:
                - generic [ref=e282]:
                  - generic [ref=e283]: Victor
                  - time [ref=e284]: 10:42 AM
                - generic [ref=e285]: Here's the Q3 performance report.
                - link "Q3-perf-report.pdf 240 KB Download Q3-perf-report.pdf" [ref=e287] [cursor=pointer]:
                  - /url: https://placehold.co/800x1100?text=Q3+Report
                  - generic [ref=e291]:
                    - generic [ref=e292]: Q3-perf-report.pdf
                    - generic [ref=e293]: 240 KB
                  - generic [ref=e297]: Download Q3-perf-report.pdf
                - button "Add a reaction" [ref=e299] [cursor=pointer]
              - button "Message actions" [ref=e307] [cursor=pointer]
            - article [ref=e313]:
              - generic [ref=e314]:
                - generic [ref=e315]:
                  - generic [ref=e316]: You
                  - time [ref=e317]: 10:45 AM
                - generic [ref=e318]: "Screenshot from the staging deploy:"
                - link "staging-deploy.png 180 KB Download staging-deploy.png" [ref=e320] [cursor=pointer]:
                  - /url: https://placehold.co/1200x800?text=Staging+Deploy
                  - generic [ref=e325]:
                    - generic [ref=e326]: staging-deploy.png
                    - generic [ref=e327]: 180 KB
                  - generic [ref=e331]: Download staging-deploy.png
                - generic [ref=e332]:
                  - button "👍 reaction, 1" [ref=e333] [cursor=pointer]:
                    - generic [aria-hidden] [ref=e334]: 👍
                    - generic [ref=e335]: "1"
                  - button "Add a reaction" [ref=e336] [cursor=pointer]
                - generic [ref=e342]: Read
              - button "Message actions" [ref=e349] [cursor=pointer]
            - article [ref=e355]:
              - generic [aria-hidden] [ref=e357]: D
              - generic [ref=e359]:
                - generic [ref=e360]:
                  - generic [ref=e361]: Daniel
                  - time [ref=e362]: 10:48 AM
                - generic [ref=e363]:
                  - link "api-spec-v2.zip 1.0 MB Download api-spec-v2.zip" [ref=e364] [cursor=pointer]:
                    - /url: https://placehold.co/400x300?text=api-spec-v2.zip
                    - generic [ref=e368]:
                      - generic [ref=e369]: api-spec-v2.zip
                      - generic [ref=e370]: 1.0 MB
                    - generic [ref=e374]: Download api-spec-v2.zip
                  - link "changelog.md 4.0 KB Download changelog.md" [ref=e375] [cursor=pointer]:
                    - /url: https://placehold.co/600x400?text=changelog.md
                    - generic [ref=e379]:
                      - generic [ref=e380]: changelog.md
                      - generic [ref=e381]: 4.0 KB
                    - generic [ref=e385]: Download changelog.md
                - button "Add a reaction" [ref=e387] [cursor=pointer]
              - button "Message actions" [ref=e395] [cursor=pointer]
            - article [ref=e401]:
              - generic [aria-hidden] [ref=e403]: V
              - generic [ref=e405]:
                - generic [ref=e406]:
                  - generic [ref=e407]: Victor
                  - time [ref=e408]: 10:50 AM
                - generic [ref=e409]: Message deleted
            - button "Jump to latest" [ref=e410] [cursor=pointer]
          - generic [ref=e412]:
            - generic [ref=e413]:
              - button [aria-hidden] [ref=e414]
              - button "Attach file" [ref=e415] [cursor=pointer]
              - button "Mention someone" [ref=e418] [cursor=pointer]
            - textbox "Message" [ref=e422]:
              - /placeholder: Message…
            - button "Send message" [disabled] [ref=e423]
```

# Test source

```ts
  258 |       `  ${label}: menu x=${r.menuLeft}..${r.menuRight} y=${r.menuTop}..${r.menuBottom} | clipper ${r.clipperTag} -> ${r.clipped ? 'CLIPPED' : 'ok'} (${r.reason})`,
  259 |     );
  260 |   }
  261 | 
  262 |   /*
  263 |    * Opens one trigger, measures the menu, closes. Kept separate so every menu
  264 |    * in the app can be put through the same check without repeating the
  265 |    * scroll/click/settle dance.
  266 |    */
  267 |   async function checkMenu(page, trigger, label) {
  268 |     await page.keyboard.press('Escape').catch(() => {});
  269 |     await trigger.scrollIntoViewIfNeeded().catch(() => {});
  270 |     await trigger.click({ force: true }).catch(() => {});
  271 |     await page.waitForTimeout(220);
  272 | 
  273 |     const menu = page.locator('[role="menu"]').last();
  274 |     const report = await menuClipReport(page, menu);
  275 |     reportClip(label, report);
  276 |     return report;
  277 |   }
  278 | 
  279 |   /*
  280 |    * The message scroller is not the first `overflow-y-auto` on the page: on
  281 |    * desktop the chat list is one too, and it precedes the room in DOM order.
  282 |    * A day separator is unique to the timeline, so require one.
  283 |    */
  284 |   const timelineScroller = (page) =>
  285 |     page.locator('div.overflow-y-auto').filter({ has: page.getByRole('separator') }).first();
  286 | 
  287 |   test('A2 — a short conversation is pinned to the composer, not stranded at the top', async ({
  288 |     page,
  289 |   }) => {
  290 |     // A tall pane is what makes this measurable: the eight fixture messages
  291 |     // must be shorter than the scroll area, or mt-auto has no free space to
  292 |     // claim and the test would assert nothing.
  293 |     await page.setViewportSize({ width: 1280, height: 1400 });
  294 |     await page.goto('/chats/preview-room');
  295 |     await settle(page);
  296 | 
  297 |     const scroller = timelineScroller(page);
  298 |     const freeSpace = await scroller.evaluate(
  299 |       (el) => el.clientHeight - el.scrollHeight,
  300 |     );
  301 |     if (freeSpace <= 60) {
  302 |       console.log(`  A2: only ${freeSpace}px free — transcript still fills the pane, inconclusive`);
  303 |       test.skip(true, 'need a pane taller than the transcript');
  304 |     }
  305 | 
  306 |     const firstRow = scroller.locator('div.mt-auto').first();
  307 |     const composer = page.locator('textarea, [contenteditable="true"]').first();
  308 |     const firstTop = (await firstRow.boundingBox()).y;
  309 |     const composerTop = (await composer.boundingBox()).y;
  310 |     const gap = composerTop - firstTop;
  311 | 
  312 |     console.log(
  313 |       `  A2: free space in pane=${Math.round(freeSpace)}px, first message y=${Math.round(firstTop)}, composer y=${Math.round(composerTop)} -> void above transcript = ${Math.round(gap)}px`,
  314 |     );
  315 | 
  316 |     // If mt-auto worked the void would be roughly `freeSpace`; if it is inert
  317 |     // the transcript hugs the top and the void is just the message block.
  318 |     expect(gap, 'mt-auto left a large void above the transcript').toBeLessThan(freeSpace * 0.6);
  319 |   });
  320 | 
  321 |   test('A3 — "Jump to latest" is inside the viewport when it is showing', async ({ page }) => {
  322 |     // The inverse of A2: a short pane so the transcript overflows and the
  323 |     // pill actually has a reason to exist.
  324 |     await page.setViewportSize({ width: 1280, height: 450 });
  325 |     await page.goto('/chats/preview-room');
  326 |     await settle(page);
  327 | 
  328 |     const scroller = timelineScroller(page);
  329 |     const scrollable = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight > 200);
  330 |     test.skip(!scrollable, 'transcript still does not overflow at 450px');
  331 | 
  332 |     const pill = page.getByRole('button', { name: 'Jump to latest' });
  333 | 
  334 |     // The timeline scrolls itself to the bottom whenever the message list
  335 |     // changes, which can land after settle() and undo a single scroll. Retry
  336 |     // until the pill is actually up.
  337 |     let box = null;
  338 |     let pane = null;
  339 |     for (let attempt = 0; attempt < 3 && !box; attempt += 1) {
  340 |       await scroller.evaluate((el) => {
  341 |         el.scrollTop = 0;
  342 |       });
  343 |       await page.waitForTimeout(400);
  344 |       if (await pill.isVisible().catch(() => false)) {
  345 |         box = await pill.boundingBox();
  346 |         pane = await scroller.boundingBox();
  347 |       }
  348 |     }
  349 | 
  350 |     if (!box) {
  351 |       console.log('  A3: pill did not appear after scrolling to the top — inconclusive');
  352 |       test.skip(true, 'pill never appeared');
  353 |     }
  354 | 
  355 |     console.log(`  A3: pill ${describeBox(box)} | pane ${describeBox(pane)}`);
  356 | 
  357 |     const offscreen = box.y >= pane.y + pane.height || box.y + box.height <= pane.y;
> 358 |     expect(offscreen, 'pill is rendered outside the visible pane').toBe(false);
      |                                                                    ^ Error: pill is rendered outside the visible pane
  359 |   });
  360 | 
  361 |   /*
  362 |    * Every dropdown in the app, on both room types.
  363 |    *
  364 |    * The original version of this test opened a single menu on the last
  365 |    * message and passed while the same control was 79% off-screen on every
  366 |    * other one: the last kebab belongs to the other participant, sits on the
  367 |    * right, and happened to fit. One sample is not a sweep — own messages are
  368 |    * right-aligned, which puts their trigger in the *left* gutter, and that is
  369 |    * the side the menu used to grow off the viewport.
  370 |    */
  371 |   for (const room of ['/chats/preview-dm', '/chats/preview-room']) {
  372 |     test(`A5 — every message menu on ${room} is fully on screen`, async ({ page }) => {
  373 |       await page.goto(room);
  374 |       await settle(page);
  375 | 
  376 |       const kebabs = page.getByLabel('Message actions');
  377 |       const count = await kebabs.count();
  378 |       test.skip(count === 0, 'no messages in fixtures');
  379 | 
  380 |       const failures = [];
  381 |       for (let i = 0; i < count; i += 1) {
  382 |         const report = await checkMenu(page, kebabs.nth(i), `${room} kebab[${i}]`);
  383 |         if (report.clipped) failures.push(`kebab[${i}]: ${report.reason}`);
  384 |       }
  385 |       await page.keyboard.press('Escape').catch(() => {});
  386 | 
  387 |       expect(failures, `${failures.length}/${count} message menus unreachable`).toEqual([]);
  388 |     });
  389 |   }
  390 | 
  391 |   test('A5b — the pinned-decision menu is not clipped by the chip scroller', async ({ page }) => {
  392 |     await page.goto('/chats/preview-room');
  393 |     await settle(page);
  394 | 
  395 |     const trigger = page.getByRole('button', { name: /pin actions/i }).first();
  396 |     test.skip(!(await trigger.isVisible().catch(() => false)), 'no pinned decisions in fixtures');
  397 | 
  398 |     const report = await checkMenu(page, trigger, 'A5b pin menu');
  399 |     expect(report.clipped, `pin menu ${report.reason}`).toBe(false);
  400 |   });
  401 | 
  402 |   test('A6 — the reaction picker stays on screen at both ends of the timeline', async ({ page }) => {
  403 |     await page.goto('/chats/preview-dm');
  404 |     await settle(page);
  405 | 
  406 |     const triggers = page.getByLabel('Add a reaction');
  407 |     const count = await triggers.count();
  408 |     test.skip(count === 0, 'no reactions in fixtures');
  409 | 
  410 |     // First and last: the picker opens upward, so the two ends are where a
  411 |     // single fixed offset runs out of room in one direction or the other.
  412 |     const targets = [0, count - 1].filter((i, idx, arr) => arr.indexOf(i) === idx);
  413 |     const failures = [];
  414 |     for (const i of targets) {
  415 |       const report = await checkMenu(page, triggers.nth(i), `A6 reaction[${i}]`);
  416 |       if (report.clipped) failures.push(`reaction[${i}]: ${report.reason}`);
  417 |     }
  418 |     await page.keyboard.press('Escape').catch(() => {});
  419 | 
  420 |     expect(failures, `${failures.length}/${targets.length} reaction pickers unreachable`).toEqual([]);
  421 |   });
  422 | 
  423 |   test('A7 — the room-row menu in the chat list is fully on screen', async ({ page }) => {
  424 |     await page.goto('/chats');
  425 |     await settle(page);
  426 | 
  427 |     const rows = page.locator('ul li').filter({ has: page.getByLabel(/^actions for/i) });
  428 |     const count = await rows.count();
  429 |     test.skip(count === 0, 'no rooms in fixtures');
  430 | 
  431 |     const failures = [];
  432 |     for (let i = 0; i < count; i += 1) {
  433 |       const report = await checkMenu(page, rows.nth(i).getByLabel(/^actions for/i), `A7 row[${i}]`);
  434 |       if (report.clipped) failures.push(`row[${i}]: ${report.reason}`);
  435 |     }
  436 |     await page.keyboard.press('Escape').catch(() => {});
  437 | 
  438 |     expect(failures, `${failures.length}/${count} row menus unreachable`).toEqual([]);
  439 |   });
  440 | 
  441 |   test('A8 — the task status menu is fully on screen, including the last card', async ({ page }) => {
  442 |     await page.goto('/tasks');
  443 |     await settle(page);
  444 | 
  445 |     const triggers = page.getByLabel(/^move .* to another column$/i);
  446 |     const count = await triggers.count();
  447 |     test.skip(count === 0, 'no tasks in fixtures');
  448 | 
  449 |     // The last card is the one the old `absolute top-9` clipped, because it
  450 |     // sits lowest in the page scroller.
  451 |     const failures = [];
  452 |     for (const i of [0, count - 1]) {
  453 |       const report = await checkMenu(page, triggers.nth(i), `A8 task[${i}]`);
  454 |       if (report.clipped) failures.push(`task[${i}]: ${report.reason}`);
  455 |     }
  456 |     await page.keyboard.press('Escape').catch(() => {});
  457 | 
  458 |     expect(failures, `${failures.length}/2 task menus unreachable`).toEqual([]);
```