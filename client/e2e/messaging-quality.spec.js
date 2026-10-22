import { test, expect } from '@playwright/test';

const APP_PROJECT = (name) => name.startsWith('app-');

test('responsive shell keeps controls on the right without horizontal overflow', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  for (const width of [360, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/chats');
    await page.waitForSelector('#root > *');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);

    const notify = await page.getByRole('link', { name: /^Notifications/ }).boundingBox();
    const menu = await page.getByRole('button', { name: /menu|sidebar/i }).boundingBox();
    expect(notify).not.toBeNull();
    expect(menu).not.toBeNull();
    expect(menu.x).toBeGreaterThan(notify.x);

    if (width < 768) {
      const logo = await page.getByRole('link', { name: 'Conclave, home' }).boundingBox();
      expect(logo).not.toBeNull();
      expect(logo.x + logo.width).toBeLessThan(notify.x);
    }
  }
});

test('open room keeps its mobile room header and form pages remain capped', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/chats/preview-room');
  await page.waitForSelector('#root > *');
  await expect(page.getByRole('link', { name: /back to chats/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Notifications/ })).toBeHidden();

  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto('/settings');
  const formContent = await page.locator('main > div > div').boundingBox();
  expect(formContent).not.toBeNull();
  expect(formContent.width).toBeLessThanOrEqual(672);
});

test('message actions open a thread panel with its reply action', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'app-desktop', 'the action menu is hover-revealed on desktop');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/chats/preview-room');
  await page.waitForSelector('#root > *');
  await page.getByRole('button', { name: 'Message actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Open thread' }).click();
  await expect(page.getByRole('complementary', { name: 'Message thread' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reply in thread' })).toBeVisible();
});

test('public room discovery can join and open a room', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  await page.goto('/discover');
  await expect(page.getByRole('heading', { name: 'Discover public rooms' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conclave Community' })).toBeVisible();
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page).toHaveURL(/\/chats\/preview-public-room$/);
});

test('a direct message reads as a one-to-one conversation, not a room', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  await page.goto('/chats/preview-dm');
  await expect(page.getByRole('heading', { name: 'Victor' })).toBeVisible();
  await expect(page.getByText('2 members')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Conversation details' })).toBeVisible();
  await page.goto('/chats/preview-dm/info');
  await expect(page.getByRole('heading', { name: 'Conversation with Victor' })).toBeVisible();
  await expect(page.getByText('A private conversation between the two of you.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'About Victor' })).toBeVisible();
  await expect(page.getByText('Product designer focused on clear, collaborative tools.')).toBeVisible();
  await expect(page.getByText('Presence unavailable', { exact: true }).first()).toBeVisible();
  const commonGroups = page.locator('section[aria-labelledby="common-groups-heading"]');
  await expect(commonGroups.getByRole('heading', { name: 'Groups in common' })).toBeVisible();
  await expect(commonGroups.getByText('Product & Engineering')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'People in this conversation' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Add people' })).toHaveCount(0);
});

test('room information describes the room and its members', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  await page.goto('/chats/preview-room/info');
  await expect(page.getByRole('heading', { name: 'Product & Engineering' })).toBeVisible();
  await expect(page.getByText('Deployment, config and release coordination for the product surface.')).toBeVisible();
  await expect(page.getByText('Created October 8, 2026')).toBeVisible();
  await expect(page.getByText('Started by Amina Yusuf')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Room members' })).toBeVisible();
  await expect(page.getByText('Presence unavailable', { exact: true }).first()).toBeVisible();
});

test('profile shows a public-facing preview and account overview', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  if (testInfo.project.name === 'app-mobile') await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Your profile', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Profile preview' })).toContainText('Amina Yusuf');
  await expect(page.getByText('Member since')).toBeVisible();
  await expect(page.getByText('Direct messages')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Edit your profile' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email address' })).toBeDisabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'profile information should fit on a phone').toBeLessThanOrEqual(1);
});

test('offline text stays queued locally and sends after the connection returns', async ({ page, context }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  await page.goto('/chats/preview-room');
  const text = `OFFLINE-QUEUE-${Date.now()}`;
  const composer = page.getByRole('textbox', { name: 'Message' });
  await expect(composer).toBeVisible();
  await context.setOffline(true);
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  const queued = page.locator('article').filter({ hasText: text }).last();
  await expect(queued).toContainText(text);
  await expect(queued.locator('[data-message-status="queued"]')).toContainText('Not sent');
  await expect(page.getByRole('status').filter({ hasText: 'Messages will wait here' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.locator('article').filter({ hasText: text })).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'Messages will wait here' })).toHaveCount(0);
});

test('a very long message wraps without horizontal overflow and accepts a reply', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  await page.setViewportSize(testInfo.project.name === 'app-mobile'
    ? { width: 390, height: 844 }
    : { width: 1280, height: 900 });
  await page.goto('/chats/preview-room');
  await page.waitForSelector('#root > *');

  const longText = Array.from({ length: 120 }, (_, i) =>
    `LONG-MSG-START paragraph ${i + 1}: This is a long message used to verify readable wrapping, scroll behavior, and reply context in a conversation.`,
  ).join('\n');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(longText);
  await page.getByRole('button', { name: 'Send message' }).click();

  const longMessage = page.locator('article').filter({ hasText: 'LONG-MSG-START paragraph 1:' }).last();
  await expect(longMessage).toContainText('paragraph 120:');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the long message must not create horizontal page overflow').toBeLessThanOrEqual(1);

  if (testInfo.project.name === 'app-mobile') {
    await longMessage.locator('div').filter({ hasText: 'LONG-MSG-START paragraph 1:' }).last()
      .dispatchEvent('contextmenu', { bubbles: true });
  } else {
    await longMessage.hover();
    await longMessage.getByRole('button', { name: 'Message actions' }).click();
  }
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await composer.fill('LONG-MSG-REPLY verified reply to the full message.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(composer).toBeVisible();
  const reply = page.locator('article').filter({ hasText: 'LONG-MSG-REPLY verified reply' }).last();
  await expect(reply).toContainText('Replying to Amina Yusuf');
});

test('pinned and replied-to messages scroll into view and glow briefly', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  await page.goto('/chats/preview-room');
  await page.getByRole('button', { name: /Pinned message/ }).click();
  await page.locator('#pinned-messages-list').getByRole('button', { name: /We are keeping the 2 hour timeout/ }).click();
  const pinnedTarget = page.locator('[data-message-id="dev-message-1"]');
  await expect(pinnedTarget).toHaveClass(/message-jump-highlight/);

  const replyQuote = page.getByRole('button', { name: /Replying to Amina Yusuf/ });
  await replyQuote.click();
  await expect(page.locator('[data-message-id="dev-message-3"]')).toHaveClass(/message-jump-highlight/);
});

test('a source-like long message keeps the mobile conversation and reply composer in the viewport', async ({ page }, testInfo) => {
  test.skip(!APP_PROJECT(testInfo.project.name), 'uses the authenticated app fixture');
  test.skip(testInfo.project.name !== 'app-mobile', 'targets the mobile conversation layout');
  await page.setViewportSize({ width: 414, height: 896 });
  await page.goto('/chats/preview-room');
  await page.waitForSelector('#root > *');

  // Similar to pasted code/policy text: long lines and markup in addition to
  // paragraphs, which stress the reply excerpt as well as the message bubble.
  const longText = `${'<div className="flex min-w-0 items-center gap-2">import { Link } from "react-router-dom"; '.repeat(180)}\n${'Your content and messages should remain readable while the conversation stays usable on a phone. '.repeat(80)}`;
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(longText);
  await page.getByRole('button', { name: 'Send message' }).click();

  const longMessage = page.locator('article').filter({ hasText: '<div className="flex min-w-0 items-center gap-2">' }).last();
  await expect(longMessage).toBeVisible();
  // Wait for durable acceptance/reset and the authoritative action target.
  await expect(composer).toHaveValue('');
  await expect(longMessage).not.toHaveAttribute('data-message-id', /^optimistic-/);
  await longMessage.locator('div').filter({ hasText: '<div className="flex min-w-0 items-center gap-2">' }).last()
    .dispatchEvent('contextmenu', { bubbles: true });
  await page.getByRole('menuitem', { name: 'Reply' }).click();

  const replyPreview = page.locator('form').getByText('Replying to Amina Yusuf', { exact: true });
  await expect(replyPreview).toBeVisible();
  const layout = await page.evaluate(() => {
    const main = document.querySelector('main');
    const room = main?.querySelector('section');
    const composerForm = main?.querySelector('form');
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box && { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
    };
    return { viewportHeight: window.innerHeight, pageHeight: document.documentElement.scrollHeight, main: rect(main), room: rect(room), composer: rect(composerForm) };
  });
  expect(layout.pageHeight, 'the document should not grow to the transcript height').toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.composer.bottom, 'the composer should remain inside the mobile viewport').toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.composer.top, 'the composer should remain below the top navigation').toBeGreaterThanOrEqual(layout.main.top);

  await composer.fill('SOURCE-LONG-REPLY reply to the long message.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('article').filter({ hasText: 'SOURCE-LONG-REPLY reply to the long message.' }).last())
    .toContainText('Replying to Amina Yusuf');
});
