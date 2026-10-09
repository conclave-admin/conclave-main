# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: visual.spec.js >> static-audit suspicions, measured >> B1/B2 — composer and toast do not collide with the bottom tab bar
- Location: e2e/visual.spec.js:500:3

# Error details

```
Error: toast overlays the bottom tab bar

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 788
Received:    844
```

# Page snapshot

```yaml
- generic [ref=e4]:
  - banner [ref=e5]:
    - navigation [ref=e6]:
      - button "Open menu" [ref=e7] [cursor=pointer]
      - paragraph [ref=e10]:
        - generic [ref=e11]:
          - link "Back to chats" [ref=e12] [cursor=pointer]:
            - /url: /chats
          - generic [ref=e15]:
            - heading "Product & Engineering" [level=1] [ref=e17]
            - paragraph [ref=e19]:
              - text: 4 members
              - generic [ref=e20]: · Live
          - link "Room information" [ref=e21] [cursor=pointer]:
            - /url: /chats/preview-room/info
      - link "Notifications, 2 unread" [ref=e26] [cursor=pointer]:
        - /url: /notifications
        - generic [ref=e29]: "2"
  - main [ref=e30]:
    - generic [ref=e33]:
      - generic [ref=e35]:
        - generic [ref=e36]: Pinned
        - list [ref=e37]:
          - listitem [ref=e38]:
            - generic [ref=e39]:
              - link "Use Socket.IO for real-time events; REST handles CRUD." [ref=e42] [cursor=pointer]:
                - /url: /decisions/dev-decision-1
              - generic [ref=e43]: Pinned to the room by Amina Yusuf
              - button "Pin actions for Use Socket.IO for real-time events; REST handles CRUD." [ref=e44] [cursor=pointer]
      - generic [ref=e50]:
        - separator "August 27" [ref=e51]
        - article [ref=e56]:
          - generic [ref=e57]:
            - generic [ref=e58]:
              - generic [ref=e59]: You
              - time [ref=e60]: 10:07 AM
            - generic [ref=e61]: After testing both approaches, we'll keep Socket.IO for real-time events and REST for CRUD.
            - generic [ref=e62]:
              - button "👍 reaction, 2" [pressed] [ref=e63] [cursor=pointer]:
                - generic [aria-hidden] [ref=e64]: 👍
                - generic [ref=e65]: "2"
              - button "🎉 reaction, 1" [ref=e66] [cursor=pointer]:
                - generic [aria-hidden] [ref=e67]: 🎉
                - generic [ref=e68]: "1"
              - button "Add a reaction" [ref=e69] [cursor=pointer]
            - generic [ref=e75]: Read
          - button "Message actions" [ref=e82] [cursor=pointer]
        - article [ref=e88]:
          - generic [aria-hidden] [ref=e90]: V
          - generic [ref=e92]:
            - generic [ref=e93]:
              - generic [ref=e94]: Victor
              - time [ref=e95]: 10:17 AM
            - generic [ref=e96]: Sounds good. This keeps our real-time path focused and reduces operational overhead.
            - button "Add a reaction" [ref=e98] [cursor=pointer]
          - button "Message actions" [ref=e106] [cursor=pointer]
        - article [ref=e112]:
          - generic [ref=e113]:
            - generic [ref=e114]:
              - generic [ref=e115]: You
              - time [ref=e116]: 10:27 AM
            - generic [ref=e117]: "@Priya can you confirm deployment readiness for the API gateway changes today?"
            - generic [ref=e118]: edited
            - button "Add a reaction" [ref=e120] [cursor=pointer]
            - generic [ref=e126]: Read
          - button "Message actions" [ref=e133] [cursor=pointer]
        - article [ref=e139]:
          - generic [aria-hidden] [ref=e141]: P
          - generic [ref=e143]:
            - generic [ref=e144]:
              - generic [ref=e145]: Priya
              - time [ref=e146]: 10:37 AM
            - generic [ref=e147]: "Replying to Amina Yusuf: @Priya can you confirm deployment readiness for the API gateway changes today?"
            - generic [ref=e148]: On it—validating the config and will update here by EOD.
            - generic [ref=e149]:
              - button "✅ reaction, 1" [ref=e150] [cursor=pointer]:
                - generic [aria-hidden] [ref=e151]: ✅
                - generic [ref=e152]: "1"
              - button "Add a reaction" [ref=e153] [cursor=pointer]
          - button "Message actions" [ref=e161] [cursor=pointer]
        - article [ref=e167]:
          - generic [aria-hidden] [ref=e169]: V
          - generic [ref=e171]:
            - generic [ref=e172]:
              - generic [ref=e173]: Victor
              - time [ref=e174]: 10:42 AM
            - generic [ref=e175]: Here's the Q3 performance report.
            - link "Q3-perf-report.pdf 240 KB Download Q3-perf-report.pdf" [ref=e177] [cursor=pointer]:
              - /url: https://placehold.co/800x1100?text=Q3+Report
              - generic [ref=e181]:
                - generic [ref=e182]: Q3-perf-report.pdf
                - generic [ref=e183]: 240 KB
              - generic [ref=e187]: Download Q3-perf-report.pdf
            - button "Add a reaction" [ref=e189] [cursor=pointer]
          - button "Message actions" [ref=e197] [cursor=pointer]
        - article [ref=e203]:
          - generic [ref=e204]:
            - generic [ref=e205]:
              - generic [ref=e206]: You
              - time [ref=e207]: 10:45 AM
            - generic [ref=e208]: "Screenshot from the staging deploy:"
            - link "staging-deploy.png 180 KB Download staging-deploy.png" [ref=e210] [cursor=pointer]:
              - /url: https://placehold.co/1200x800?text=Staging+Deploy
              - generic [ref=e215]:
                - generic [ref=e216]: staging-deploy.png
                - generic [ref=e217]: 180 KB
              - generic [ref=e221]: Download staging-deploy.png
            - generic [ref=e222]:
              - button "👍 reaction, 1" [ref=e223] [cursor=pointer]:
                - generic [aria-hidden] [ref=e224]: 👍
                - generic [ref=e225]: "1"
              - button "Add a reaction" [ref=e226] [cursor=pointer]
            - generic [ref=e232]: Read
          - button "Message actions" [ref=e239] [cursor=pointer]
        - article [ref=e245]:
          - generic [aria-hidden] [ref=e247]: D
          - generic [ref=e249]:
            - generic [ref=e250]:
              - generic [ref=e251]: Daniel
              - time [ref=e252]: 10:48 AM
            - generic [ref=e253]:
              - link "api-spec-v2.zip 1.0 MB Download api-spec-v2.zip" [ref=e254] [cursor=pointer]:
                - /url: https://placehold.co/400x300?text=api-spec-v2.zip
                - generic [ref=e258]:
                  - generic [ref=e259]: api-spec-v2.zip
                  - generic [ref=e260]: 1.0 MB
                - generic [ref=e264]: Download api-spec-v2.zip
              - link "changelog.md 4.0 KB Download changelog.md" [ref=e265] [cursor=pointer]:
                - /url: https://placehold.co/600x400?text=changelog.md
                - generic [ref=e269]:
                  - generic [ref=e270]: changelog.md
                  - generic [ref=e271]: 4.0 KB
                - generic [ref=e275]: Download changelog.md
            - button "Add a reaction" [ref=e277] [cursor=pointer]
          - button "Message actions" [ref=e285] [cursor=pointer]
        - article [ref=e291]:
          - generic [aria-hidden] [ref=e293]: V
          - generic [ref=e295]:
            - generic [ref=e296]:
              - generic [ref=e297]: Victor
              - time [ref=e298]: 10:50 AM
            - generic [ref=e299]: Message deleted
        - separator "Today" [ref=e300]
        - article [ref=e305]:
          - generic [ref=e306]:
            - generic [ref=e307]:
              - generic [ref=e308]: You
              - time [ref=e309]: 04:39 PM
            - generic [ref=e310]: visual audit probe
            - button "Add a reaction" [ref=e312] [cursor=pointer]
            - generic [ref=e318]: Sent
          - button "Message actions" [ref=e325] [cursor=pointer]
        - button "Jump to latest" [ref=e330] [cursor=pointer]
      - generic [ref=e332]:
        - generic [ref=e333]:
          - button [aria-hidden] [ref=e334]
          - button "Attach file" [ref=e335] [cursor=pointer]
          - button "Mention someone" [ref=e338] [cursor=pointer]
        - textbox "Message" [ref=e342]:
          - /placeholder: Message…
        - button "Send message" [disabled] [ref=e343]
  - navigation "Primary" [ref=e347]:
    - link "3 Chats" [ref=e348] [cursor=pointer]:
      - /url: /chats
      - generic [ref=e349]: "3"
      - generic [ref=e354]: Chats
    - link "Tasks" [ref=e355] [cursor=pointer]:
      - /url: /tasks
    - link "Decisions" [ref=e361] [cursor=pointer]:
      - /url: /decisions
    - link "Me" [ref=e367] [cursor=pointer]:
      - /url: /profile
```

# Test source

```ts
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
  459 |   });
  460 | 
  461 |   test('A9 — rail rows keep their height and never overlap the profile block', async ({ page }) => {
  462 |     // Below ~640px of height the rail has less room than its fixed parts need,
  463 |     // and a flex column compresses its children rather than scrolling unless
  464 |     // told not to. This walks the range where that used to break.
  465 |     for (const height of [800, 700, 640, 600, 520, 440]) {
  466 |       await page.setViewportSize({ width: 1280, height });
  467 |       await page.goto('/chats');
  468 |       await settle(page);
  469 | 
  470 |       const result = await page.evaluate(() => {
  471 |         const profile = document.querySelector('a[href="/profile"]');
  472 |         const rail = profile?.closest('div.min-h-0');
  473 |         if (!rail) return { error: 'rail not found' };
  474 | 
  475 |         const boxes = [...rail.querySelectorAll('a')].map((a) => a.getBoundingClientRect());
  476 |         let overlapping = 0;
  477 |         for (let i = 0; i < boxes.length; i += 1) {
  478 |           for (let j = i + 1; j < boxes.length; j += 1) {
  479 |             if (boxes[i].top < boxes[j].bottom - 1 && boxes[j].top < boxes[i].bottom - 1) overlapping += 1;
  480 |           }
  481 |         }
  482 |         const roomRows = [...rail.querySelectorAll('a[href^="/chats/"]')].map((a) =>
  483 |           Math.round(a.getBoundingClientRect().height),
  484 |         );
  485 |         return { overlapping, roomRows };
  486 |       });
  487 | 
  488 |       expect(result.error ?? '', `at ${height}px tall`).toBe('');
  489 |       expect(
  490 |         result.overlapping,
  491 |         `at ${height}px tall, ${result.overlapping} rail links overlap each other`,
  492 |       ).toBe(0);
  493 |       // A compressed row is a row whose hit target is smaller than it looks.
  494 |       for (const h of result.roomRows) {
  495 |         expect(h, `at ${height}px tall, a room row is ${h}px instead of 36px`).toBe(36);
  496 |       }
  497 |     }
  498 |   });
  499 | 
  500 |   test('B1/B2 — composer and toast do not collide with the bottom tab bar', async ({ page }, testInfo) => {
  501 |     // BottomNav is `md:hidden`, so it does not exist at desktop width and
  502 |     // there is nothing to collide with.
  503 |     test.skip(testInfo.project.name !== 'app-mobile', 'tab bar only exists below md');
  504 | 
  505 |     await page.goto('/chats/preview-room');
  506 |     await settle(page);
  507 | 
  508 |     const tabbar = page.locator('nav.md\\:hidden, nav').last();
  509 |     const tabBox = await tabbar.boundingBox();
  510 |     const composer = page.locator('textarea, [contenteditable="true"]').first();
  511 |     const compBox = await composer.boundingBox();
  512 | 
  513 |     console.log(
  514 |       `  B1: composer y=${Math.round(compBox.y)}..${Math.round(compBox.y + compBox.height)} | tabbar y=${Math.round(tabBox.y)}..${Math.round(tabBox.y + tabBox.height)}`,
  515 |     );
  516 |     expect(
  517 |       compBox.y + compBox.height,
  518 |       'composer bottom overlaps the bottom tab bar',
  519 |     ).toBeLessThanOrEqual(tabBox.y + 1);
  520 | 
  521 |     const send = page.getByRole('button', { name: /send/i }).first();
  522 |     if (await send.isVisible().catch(() => false)) {
  523 |       await composer.click();
  524 |       await composer.fill('visual audit probe');
  525 |       await send.click();
  526 |       await page.waitForTimeout(600);
  527 | 
  528 |       const toast = page.locator('div.fixed').last();
  529 |       if (await toast.isVisible().catch(() => false)) {
  530 |         const toastBox = await toast.boundingBox();
  531 |         console.log(`  B2: toast ${describeBox(toastBox)} | tabbar ${describeBox(tabBox)}`);
  532 |         expect(
  533 |           toastBox.y + toastBox.height,
  534 |           'toast overlays the bottom tab bar',
> 535 |         ).toBeLessThanOrEqual(tabBox.y + 1);
      |           ^ Error: toast overlays the bottom tab bar
  536 |       } else {
  537 |         console.log('  B2: no toast raised — skipped');
  538 |       }
  539 |     }
  540 |   });
  541 | 
  542 |   test('B4 — primary icon controls meet a 24px minimum box', async ({ page }) => {
  543 |     await page.goto('/chats');
  544 |     await settle(page);
  545 | 
  546 |     const targets = [
  547 |       ['navbar menu', page.locator('header button').first()],
  548 |       ['navbar bell', page.getByRole('link', { name: /notifications/i }).first()],
  549 |     ];
  550 | 
  551 |     let measured = 0;
  552 |     for (const [label, locator] of targets) {
  553 |       if (!(await locator.isVisible().catch(() => false))) continue;
  554 |       const box = await locator.boundingBox();
  555 |       const min = Math.min(box.width, box.height);
  556 |       measured += 1;
  557 |       console.log(`  B4: ${label} = ${Math.round(box.width)}x${Math.round(box.height)} (min ${Math.round(min)}px)`);
  558 |       expect(min, `${label} is below the 24px touch minimum`).toBeGreaterThanOrEqual(24);
  559 |     }
  560 |     expect(measured, 'no controls found to measure').toBeGreaterThan(0);
  561 |   });
  562 | 
  563 |   test('C6 — surfaces sized in 100vh do not jump when the URL bar collapses', async ({ page }) => {
  564 |     await page.setViewportSize({ width: 390, height: 800 });
  565 |     await page.goto('/pricing');
  566 |     await settle(page);
  567 | 
  568 |     const before = await page.evaluate(() => document.documentElement.clientHeight);
  569 |     await page.setViewportSize({ width: 390, height: 560 });
  570 |     await page.waitForTimeout(400);
  571 |     const after = await page.evaluate(() => document.documentElement.clientHeight);
  572 | 
  573 |     const suspect = await page.evaluate(() =>
  574 |       [...document.querySelectorAll('*')]
  575 |         .filter((el) => getComputedStyle(el).minHeight === `${window.innerHeight}px`)
  576 |         .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`),
  577 |     );
  578 | 
  579 |     console.log(
  580 |       `  C6: viewport ${before}px -> ${after}px after collapse; elements sized to 100vh: ${suspect.length ? [...new Set(suspect)].join(', ') : 'none'}`,
  581 |     );
  582 |     expect(suspect.length, `these are sized in 100vh and will jump: ${suspect.join(', ')}`).toBe(0);
  583 |   });
  584 | });
  585 | 
```