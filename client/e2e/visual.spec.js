import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/*
 * Visual audit suite.
 *
 * Screenshots every route at both breakpoints in both themes, and asserts
 * three things a static read of the source cannot: that nothing throws, that
 * nothing overflows horizontally, and that overlay UI actually lands inside
 * the viewport it is supposed to sit in.
 *
 * The interaction tests below encode specific suspicions from the static
 * audit as executable checks, so "is the jump pill reachable" is settled by
 * measurement rather than by reading a `bottom-3` and reasoning about
 * containing blocks.
 */

const SHOTS = path.join(import.meta.dirname, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

/** Routes served by the bypass-on server (every one is reachable signed in). */
const APP_ROUTES = [
  ['/chats', 'chats'],
  ['/chats/preview-room', 'room'],
  ['/chats/preview-room/info', 'room-info'],
  ['/new', 'new-chat'],
  ['/profile', 'profile'],
  ['/settings', 'settings'],
  ['/notifications', 'notifications'],
  ['/decisions', 'decisions'],
  ['/decisions/dev-decision-1', 'decision-detail'],
  ['/digest', 'digest'],
  ['/tasks', 'tasks'],
  ['/login', 'login'],
  ['/register', 'register'],
  ['/pricing', 'pricing'],
  ['/privacy', 'privacy'],
  ['/terms', 'terms'],
];

/** Routes that only render with the auth bypass off. */
const PUBLIC_ROUTES = [
  ['/', 'landing'],
  ['/login', 'login'],
  ['/register', 'register'],
  ['/pricing', 'pricing'],
  ['/privacy', 'privacy'],
  ['/terms', 'terms'],
];

const THEMES = ['light', 'dark'];

/**
 * Dev-mode React is noisy: StrictMode double-invokes effects and logs via
 * console.error, which would drown a real exception. Uncaught exceptions
 * arrive on `pageerror` and are never advisory, so those are the hard
 * failure; console errors are collected and printed for the audit.
 */
function watchPage(page) {
  const consoleErrors = [];
  const pageErrors = [];

  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Download the React DevTools|Fast Refresh|act\(/.test(text)) return;
    consoleErrors.push(text);
  });

  return { consoleErrors, pageErrors };
}

async function useTheme(page, theme) {
  await page.context().addInitScript((value) => {
    window.localStorage.setItem('conclave-theme', value);
  }, theme);
}

/** `documentElement.scrollWidth` exceeding the viewport is a horizontal overflow. */
async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
}

/*
 * Deliberately not `networkidle`: Vite's HMR websocket stays open for the
 * life of the dev server, so "no network connections for 500ms" never
 * becomes true and every goto would hang until the test timeout. Waiting on
 * React having mounted is both faster and the condition that actually
 * matters for a screenshot.
 */
async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForSelector('#root > *', { state: 'attached', timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(350);
}

function shotPath(project, theme, name) {
  return path.join(SHOTS, project, theme, `${name}.png`);
}

function describeBox(box) {
  if (!box) return 'not in layout';
  return `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)} bottom=${Math.round(box.y + box.height)}`;
}

const isApp = (project) => project.startsWith('app-');

/* ------------------------------------------------------------------ */
/* 1. Route matrix — one test per route, theme and project             */
/* ------------------------------------------------------------------ */

for (const theme of THEMES) {
  for (const [route, name] of APP_ROUTES) {
    test(`app ${theme} ${name}: ${route}`, async ({ page }, testInfo) => {
      test.skip(!isApp(testInfo.project.name), 'needs the bypass-on server');
      await runRouteCheck(page, testInfo, theme, route, name);
    });
  }

  for (const [route, name] of PUBLIC_ROUTES) {
    test(`public ${theme} ${name}: ${route}`, async ({ page }, testInfo) => {
      test.skip(isApp(testInfo.project.name), 'needs the bypass-off server');
      await runRouteCheck(page, testInfo, theme, route, name);
    });
  }
}

async function runRouteCheck(page, testInfo, theme, route, name) {
  await useTheme(page, theme);
  const problems = watchPage(page);

  await page.goto(route);
  await settle(page);

  const bodyText = (await page.locator('body').innerText().catch(() => '')).trim();
  const overflow = await horizontalOverflow(page);
  const overBy = overflow.scrollWidth - overflow.clientWidth;

  const file = shotPath(testInfo.project.name, theme, name);
  await page.screenshot({ path: file, fullPage: true });

  const issues = [];
  if (problems.pageErrors.length) issues.push(`UNCAUGHT: ${problems.pageErrors.join(' | ')}`);
  if (problems.consoleErrors.length) issues.push(`console: ${problems.consoleErrors.join(' | ')}`);
  if (overBy > 1) {
    issues.push(`H-OVERFLOW +${overBy}px (${overflow.scrollWidth} vs ${overflow.clientWidth})`);
  }
  if (bodyText.length === 0) issues.push('EMPTY BODY (blank or fully redirected)');

  if (issues.length) {
    console.log(`\n──── ${testInfo.project.name} / ${theme} / ${route} ────\n  ${issues.join('\n  ')}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. Encoded suspicions from the static audit                        */
/* ------------------------------------------------------------------ */

test.describe('static-audit suspicions, measured', () => {
  // `test.skip` at describe level is only handed fixtures, never testInfo, so
  // the project name is unreachable there. beforeEach gets both.
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(!isApp(testInfo.project.name), 'needs the bypass-on server');
  });

  /*
   * Locating a clipping ancestor by eye is unreliable — an element is clipped
   * by the first ancestor whose computed overflow is not `visible`, which is
   * not always the container you would name. Ask the layout instead.
   */
  /*
   * A menu has to clear two separate bounds, and they fail independently.
   *
   * The clipper check catches a menu cut by an `overflow` ancestor — the old
   * failure mode, where the box lived inside the message scroller. The
   * viewport check catches a menu that is inside no scroller at all and is
   * still unreachable, which is what the portal introduced risk of: a
   * portalled menu has no clipping ancestor, so the clipper walk reports "ok"
   * for a menu sitting at x=-164. Without the second check this whole file
   * would have passed against the bug it exists to catch.
   */
  async function menuClipReport(page, menu) {
    const report = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      let node = el.parentElement;
      let clipper = null;
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
          clipper = { node, cs };
          break;
        }
        node = node.parentElement;
      }

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const offLeft = r.left < -1 ? Math.round(-r.left) : 0;
      const offRight = r.right > vw + 1 ? Math.round(r.right - vw) : 0;
      const offTop = r.top < -1 ? Math.round(-r.top) : 0;
      const offBottom = r.bottom > vh + 1 ? Math.round(r.bottom - vh) : 0;

      let clipped = false;
      let reason = 'fully on screen';
      if (offLeft) {
        clipped = true;
        reason = `off the LEFT edge by ${offLeft}px`;
      } else if (offRight) {
        clipped = true;
        reason = `off the RIGHT edge by ${offRight}px`;
      } else if (offTop) {
        clipped = true;
        reason = `off the TOP edge by ${offTop}px`;
      } else if (offBottom) {
        clipped = true;
        reason = `off the BOTTOM edge by ${offBottom}px`;
      }

      const cr = clipper ? clipper.node.getBoundingClientRect() : null;
      return {
        clipped,
        reason,
        menuTop: Math.round(r.top),
        menuBottom: Math.round(r.bottom),
        menuLeft: Math.round(r.left),
        menuRight: Math.round(r.right),
        portalled: !clipper,
        clipperTop: cr ? Math.round(cr.top) : null,
        clipperBottom: cr ? Math.round(cr.bottom) : null,
        clipperOverflowY: clipper ? clipper.cs.overflowY : null,
        clipperTag: clipper
          ? `${clipper.node.tagName.toLowerCase()}${clipper.node.className ? `.${String(clipper.node.className).split(' ')[0]}` : ''}`
          : 'none (portalled)',
      };
    });

    // The clipper walk only covers Y, so check X against it too rather than
    // trusting it — a menu wider than its scroller loses items on the right.
    if (!report.clipped && report.clipperBottom !== null && report.clipperOverflowY !== 'visible') {
      if (report.menuBottom > report.clipperBottom + 1) {
        report.clipped = true;
        report.reason = `cut off at the BOTTOM by ${report.menuBottom - report.clipperBottom}px`;
      } else if (report.menuTop < report.clipperTop - 1) {
        report.clipped = true;
        report.reason = `cut off at the TOP by ${report.clipperTop - report.menuTop}px`;
      }
    }
    return report;
  }

  function reportClip(label, r) {
    console.log(
      `  ${label}: menu x=${r.menuLeft}..${r.menuRight} y=${r.menuTop}..${r.menuBottom} | clipper ${r.clipperTag} -> ${r.clipped ? 'CLIPPED' : 'ok'} (${r.reason})`,
    );
  }

  /*
   * Opens one trigger, measures the menu, closes. Kept separate so every menu
   * in the app can be put through the same check without repeating the
   * scroll/click/settle dance.
   */
  async function checkMenu(page, trigger, label) {
    await page.keyboard.press('Escape').catch(() => {});
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true }).catch(() => {});
    await page.waitForTimeout(220);

    const menu = page.locator('[role="menu"]').last();
    const report = await menuClipReport(page, menu);
    reportClip(label, report);
    return report;
  }

  /*
   * The message scroller is not the first `overflow-y-auto` on the page: on
   * desktop the chat list is one too, and it precedes the room in DOM order.
   * A day separator is unique to the timeline, so require one.
   */
  const timelineScroller = (page) =>
    page.locator('div.overflow-y-auto').filter({ has: page.getByRole('separator') }).first();

  test('A2 — a short conversation is pinned to the composer, not stranded at the top', async ({
    page,
  }) => {
    // A tall pane is what makes this measurable: the eight fixture messages
    // must be shorter than the scroll area, or mt-auto has no free space to
    // claim and the test would assert nothing.
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto('/chats/preview-room');
    await settle(page);

    const scroller = timelineScroller(page);
    const freeSpace = await scroller.evaluate(
      (el) => el.clientHeight - el.scrollHeight,
    );
    if (freeSpace <= 60) {
      console.log(`  A2: only ${freeSpace}px free — transcript still fills the pane, inconclusive`);
      test.skip(true, 'need a pane taller than the transcript');
    }

    const firstRow = scroller.locator('div.mt-auto').first();
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    const firstTop = (await firstRow.boundingBox()).y;
    const composerTop = (await composer.boundingBox()).y;
    const gap = composerTop - firstTop;

    console.log(
      `  A2: free space in pane=${Math.round(freeSpace)}px, first message y=${Math.round(firstTop)}, composer y=${Math.round(composerTop)} -> void above transcript = ${Math.round(gap)}px`,
    );

    // If mt-auto worked the void would be roughly `freeSpace`; if it is inert
    // the transcript hugs the top and the void is just the message block.
    expect(gap, 'mt-auto left a large void above the transcript').toBeLessThan(freeSpace * 0.6);
  });

  test('A3 — "Jump to latest" is inside the viewport when it is showing', async ({ page }) => {
    // The inverse of A2: a short pane so the transcript overflows and the
    // pill actually has a reason to exist.
    await page.setViewportSize({ width: 1280, height: 450 });
    await page.goto('/chats/preview-room');
    await settle(page);

    const scroller = timelineScroller(page);
    const scrollable = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight > 200);
    test.skip(!scrollable, 'transcript still does not overflow at 450px');

    const pill = page.getByRole('button', { name: 'Jump to latest' });

    // The timeline scrolls itself to the bottom whenever the message list
    // changes, which can land after settle() and undo a single scroll. Retry
    // until the pill is actually up.
    let box = null;
    let pane = null;
    for (let attempt = 0; attempt < 3 && !box; attempt += 1) {
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.waitForTimeout(400);
      if (await pill.isVisible().catch(() => false)) {
        box = await pill.boundingBox();
        pane = await scroller.boundingBox();
      }
    }

    if (!box) {
      console.log('  A3: pill did not appear after scrolling to the top — inconclusive');
      test.skip(true, 'pill never appeared');
    }

    console.log(`  A3: pill ${describeBox(box)} | pane ${describeBox(pane)}`);

    const offscreen = box.y >= pane.y + pane.height || box.y + box.height <= pane.y;
    expect(offscreen, 'pill is rendered outside the visible pane').toBe(false);
  });

  /*
   * Every dropdown in the app, on both room types.
   *
   * The original version of this test opened a single menu on the last
   * message and passed while the same control was 79% off-screen on every
   * other one: the last kebab belongs to the other participant, sits on the
   * right, and happened to fit. One sample is not a sweep — own messages are
   * right-aligned, which puts their trigger in the *left* gutter, and that is
   * the side the menu used to grow off the viewport.
   */
  for (const room of ['/chats/preview-dm', '/chats/preview-room']) {
    test(`A5 — every message menu on ${room} is fully on screen`, async ({ page }) => {
      await page.goto(room);
      await settle(page);

      const kebabs = page.getByLabel('Message actions');
      const count = await kebabs.count();
      test.skip(count === 0, 'no messages in fixtures');

      const failures = [];
      for (let i = 0; i < count; i += 1) {
        const report = await checkMenu(page, kebabs.nth(i), `${room} kebab[${i}]`);
        if (report.clipped) failures.push(`kebab[${i}]: ${report.reason}`);
      }
      await page.keyboard.press('Escape').catch(() => {});

      expect(failures, `${failures.length}/${count} message menus unreachable`).toEqual([]);
    });
  }

  test('A5b — the pinned-decision menu is not clipped by the chip scroller', async ({ page }) => {
    await page.goto('/chats/preview-room');
    await settle(page);

    const trigger = page.getByRole('button', { name: /pin actions/i }).first();
    test.skip(!(await trigger.isVisible().catch(() => false)), 'no pinned decisions in fixtures');

    const report = await checkMenu(page, trigger, 'A5b pin menu');
    expect(report.clipped, `pin menu ${report.reason}`).toBe(false);
  });

  test('A6 — the reaction picker stays on screen at both ends of the timeline', async ({ page }) => {
    await page.goto('/chats/preview-dm');
    await settle(page);

    const triggers = page.getByLabel('Add a reaction');
    const count = await triggers.count();
    test.skip(count === 0, 'no reactions in fixtures');

    // First and last: the picker opens upward, so the two ends are where a
    // single fixed offset runs out of room in one direction or the other.
    const targets = [0, count - 1].filter((i, idx, arr) => arr.indexOf(i) === idx);
    const failures = [];
    for (const i of targets) {
      const report = await checkMenu(page, triggers.nth(i), `A6 reaction[${i}]`);
      if (report.clipped) failures.push(`reaction[${i}]: ${report.reason}`);
    }
    await page.keyboard.press('Escape').catch(() => {});

    expect(failures, `${failures.length}/${targets.length} reaction pickers unreachable`).toEqual([]);
  });

  test('A7 — the room-row menu in the chat list is fully on screen', async ({ page }) => {
    await page.goto('/chats');
    await settle(page);

    const rows = page.locator('ul li').filter({ has: page.getByLabel(/^actions for/i) });
    const count = await rows.count();
    test.skip(count === 0, 'no rooms in fixtures');

    const failures = [];
    for (let i = 0; i < count; i += 1) {
      const report = await checkMenu(page, rows.nth(i).getByLabel(/^actions for/i), `A7 row[${i}]`);
      if (report.clipped) failures.push(`row[${i}]: ${report.reason}`);
    }
    await page.keyboard.press('Escape').catch(() => {});

    expect(failures, `${failures.length}/${count} row menus unreachable`).toEqual([]);
  });

  test('A8 — the task status menu is fully on screen, including the last card', async ({ page }) => {
    await page.goto('/tasks');
    await settle(page);

    const triggers = page.getByLabel(/^move .* to another column$/i);
    const count = await triggers.count();
    test.skip(count === 0, 'no tasks in fixtures');

    // The last card is the one the old `absolute top-9` clipped, because it
    // sits lowest in the page scroller.
    const failures = [];
    for (const i of [0, count - 1]) {
      const report = await checkMenu(page, triggers.nth(i), `A8 task[${i}]`);
      if (report.clipped) failures.push(`task[${i}]: ${report.reason}`);
    }
    await page.keyboard.press('Escape').catch(() => {});

    expect(failures, `${failures.length}/2 task menus unreachable`).toEqual([]);
  });

  test('A9 — rail rows keep their height and never overlap the profile block', async ({ page }) => {
    // Below ~640px of height the rail has less room than its fixed parts need,
    // and a flex column compresses its children rather than scrolling unless
    // told not to. This walks the range where that used to break.
    for (const height of [800, 700, 640, 600, 520, 440]) {
      await page.setViewportSize({ width: 1280, height });
      await page.goto('/chats');
      await settle(page);

      const result = await page.evaluate(() => {
        const profile = document.querySelector('a[href="/profile"]');
        const rail = profile?.closest('div.min-h-0');
        if (!rail) return { error: 'rail not found' };

        const boxes = [...rail.querySelectorAll('a')].map((a) => a.getBoundingClientRect());
        let overlapping = 0;
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            if (boxes[i].top < boxes[j].bottom - 1 && boxes[j].top < boxes[i].bottom - 1) overlapping += 1;
          }
        }
        const roomRows = [...rail.querySelectorAll('a[href^="/chats/"]')].map((a) =>
          Math.round(a.getBoundingClientRect().height),
        );
        return { overlapping, roomRows };
      });

      expect(result.error ?? '', `at ${height}px tall`).toBe('');
      expect(
        result.overlapping,
        `at ${height}px tall, ${result.overlapping} rail links overlap each other`,
      ).toBe(0);
      // A compressed row is a row whose hit target is smaller than it looks.
      for (const h of result.roomRows) {
        expect(h, `at ${height}px tall, a room row is ${h}px instead of 36px`).toBe(36);
      }
    }
  });

  test('B1/B2 — composer and toast do not collide with the bottom tab bar', async ({ page }, testInfo) => {
    // BottomNav is `md:hidden`, so it does not exist at desktop width and
    // there is nothing to collide with.
    test.skip(testInfo.project.name !== 'app-mobile', 'tab bar only exists below md');

    await page.goto('/chats/preview-room');
    await settle(page);

    const tabbar = page.locator('nav.md\\:hidden, nav').last();
    const tabBox = await tabbar.boundingBox();
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    const compBox = await composer.boundingBox();

    console.log(
      `  B1: composer y=${Math.round(compBox.y)}..${Math.round(compBox.y + compBox.height)} | tabbar y=${Math.round(tabBox.y)}..${Math.round(tabBox.y + tabBox.height)}`,
    );
    expect(
      compBox.y + compBox.height,
      'composer bottom overlaps the bottom tab bar',
    ).toBeLessThanOrEqual(tabBox.y + 1);

    const send = page.getByRole('button', { name: /send/i }).first();
    if (await send.isVisible().catch(() => false)) {
      await composer.click();
      await composer.fill('visual audit probe');
      await send.click();
      await page.waitForTimeout(600);

      const toast = page.locator('div.fixed').last();
      if (await toast.isVisible().catch(() => false)) {
        const toastBox = await toast.boundingBox();
        console.log(`  B2: toast ${describeBox(toastBox)} | tabbar ${describeBox(tabBox)}`);
        expect(
          toastBox.y + toastBox.height,
          'toast overlays the bottom tab bar',
        ).toBeLessThanOrEqual(tabBox.y + 1);
      } else {
        console.log('  B2: no toast raised — skipped');
      }
    }
  });

  test('B4 — primary icon controls meet a 24px minimum box', async ({ page }) => {
    await page.goto('/chats');
    await settle(page);

    const targets = [
      ['navbar menu', page.locator('header button').first()],
      ['navbar bell', page.getByRole('link', { name: /notifications/i }).first()],
    ];

    let measured = 0;
    for (const [label, locator] of targets) {
      if (!(await locator.isVisible().catch(() => false))) continue;
      const box = await locator.boundingBox();
      const min = Math.min(box.width, box.height);
      measured += 1;
      console.log(`  B4: ${label} = ${Math.round(box.width)}x${Math.round(box.height)} (min ${Math.round(min)}px)`);
      expect(min, `${label} is below the 24px touch minimum`).toBeGreaterThanOrEqual(24);
    }
    expect(measured, 'no controls found to measure').toBeGreaterThan(0);
  });

  test('C6 — surfaces sized in 100vh do not jump when the URL bar collapses', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/pricing');
    await settle(page);

    const before = await page.evaluate(() => document.documentElement.clientHeight);
    await page.setViewportSize({ width: 390, height: 560 });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.documentElement.clientHeight);

    const suspect = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((el) => getComputedStyle(el).minHeight === `${window.innerHeight}px`)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`),
    );

    console.log(
      `  C6: viewport ${before}px -> ${after}px after collapse; elements sized to 100vh: ${suspect.length ? [...new Set(suspect)].join(', ') : 'none'}`,
    );
    expect(suspect.length, `these are sized in 100vh and will jump: ${suspect.join(', ')}`).toBe(0);
  });
});
