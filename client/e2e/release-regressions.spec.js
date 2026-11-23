import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/src/config/devPreview.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}
      window.__releaseEmit=(name,payload)=>listeners.get(name)?.forEach(fn=>fn(payload));
    ` });
  });
});

async function ready(page) {
  await page.goto('/chats/preview-room');
  await expect(page.getByRole('main')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseEmit)).toBe('function');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}
async function notify(page, text, roomId = 'preview-dm') {
  await page.evaluate(({ text, roomId }) => window.__releaseEmit('notification', {
    notification: { id: `release-${text}`, type: 'new_message', context: {
      room_id: roomId, actor_name: 'Release sender', message_preview: text,
    } },
  }), { text, roomId });
}

test('keyboard skip link focuses main without changing the route', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page).toHaveURL(/\/chats\/preview-room$/);
});

test('sidebar navigation keeps the shell mounted while a lazy page loads', async ({ page }, info) => {
  await ready(page);
  await page.evaluate(() => {
    window.__originalMain = document.querySelector('main');
    window.__originalShell = document.querySelector('.app-shell');
  });
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  await page.route('**/src/pages/Settings.jsx*', async route => {
    await loading;
    await route.continue();
  });
  try {
    if (info.project.use.isMobile)
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.locator('a[href="/settings"]:visible').first().click();
    await expect(page.getByRole('status').filter({ hasText: 'Loading page' })).toBeVisible();
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await page.evaluate(() => window.__originalMain === document.querySelector('main'))).toBe(true);
    release();
    await expect(page.getByRole('status').filter({ hasText: 'Loading page' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings$/);
    expect(await page.evaluate(() =>
      window.__originalMain === document.querySelector('main') &&
      window.__originalShell === document.querySelector('.app-shell')
    )).toBe(true);
  } finally {
    release();
  }
});

test('notification toast pauses on focus and hover then opens a nested conversation safely', async ({ page }) => {
  await ready(page);
  await page.clock.install();
  await notify(page, 'Release timer message');
  const toast = page.getByRole('status').filter({ hasText: 'Release timer message' });
  await expect(toast).toBeVisible();
  const open = toast.getByRole('button').first();
  await open.focus();
  await page.clock.runFor(6000);
  await expect(toast).toBeVisible();
  await toast.hover();
  await open.evaluate(element => element.blur());
  await page.clock.runFor(6000);
  await expect(toast).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(/\/chats\/preview-dm$/);
  await expect(toast).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/chats\/preview-room$/);
  await page.reload();
  await expect(page.getByRole('main')).toBeVisible();
});

test('hidden notifications do not create a toast or start sound', async ({ page }) => {
  await page.addInitScript(() => {
    window.__audioStarts = 0;
    window.AudioContext = class { constructor() { window.__audioStarts++; } };
  });
  await ready(page);
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
  await notify(page, 'Hidden release message');
  await expect(page.getByRole('status').filter({ hasText: 'Hidden release message' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__audioStarts)).toBe(0);
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }));
  await notify(page, 'Visible release message');
  await expect(page.getByRole('status').filter({ hasText: 'Visible release message' })).toBeVisible();
});

test('notification identifiers cannot navigate outside the application origin', async ({ page }) => {
  await ready(page);
  await notify(page, 'Untrusted release message', '\\evil.example/path');
  await page.getByRole('status').filter({ hasText: 'Untrusted release message' }).getByRole('button').first().click();
  expect(new URL(page.url()).origin).toBe(new URL(test.info().project.use.baseURL).origin);
});

test('reduced motion disables shell animation and toast animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  await notify(page, 'Reduced motion release message');
  const toast = page.getByRole('status').filter({ hasText: 'Reduced motion release message' });
  await expect(toast).toBeVisible();
  expect(await toast.evaluate(element => getComputedStyle(element.parentElement).animationName)).toBe('none');
  expect(await page.locator('.app-shell').evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.00001);
});
