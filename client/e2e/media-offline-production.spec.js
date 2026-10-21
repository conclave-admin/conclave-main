import { test, expect } from '@playwright/test';

test('the built app reloads fully offline with its authenticated media draft intact', async ({ page, context }, info) => {
  test.skip(!info.project.name.startsWith('production-'), 'uses the built app and real service worker');
  const user = { id: '10000000-0000-4000-8000-000000000002', display_name: 'Offline Sender', email: 'sender@example.test' };
  const roomId = '20000000-0000-4000-8000-000000000002';
  const room = { id: roomId, name: 'Offline Room', display_name: 'Offline Room', type: 'group',
    member_count: 1, my_role: 'admin', members: [{ ...user, role: 'admin' }] };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const attachmentId = '40000000-0000-4000-8000-000000000002';
  const received = { id: '30000000-0000-4000-8000-000000000002', room_id: roomId,
    sender_id: 'peer', sender_name: 'Peer', content: 'RECEIVED-OFFLINE-PHOTO',
    created_at: new Date().toISOString(), reactions: [], pins: { mine: [], room: null },
    attachments: [{ id: attachmentId, url: 'r2://private/received-original', filename: 'received.png',
      mime_type: 'image/png', size: png.length, width: 160, height: 90, preview_url: null }] };
  let originals = 0;
  let unreachable = false;
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', (route) => {
    if (unreachable) return route.abort();
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/attachments/${attachmentId}`)) { originals++; return route.fulfill({ contentType: 'image/png', body: png }); }
    const data = path.endsWith('/users/me') ? user
      : path.endsWith(`/rooms/${roomId}`) ? room
      : path.endsWith('/rooms') ? [room]
      : path.includes('/messages/') ? { messages: path.endsWith(`/room/${roomId}`) ? [received] : [], nextCursor: null }
      : path.includes('/decisions') ? { decisions: [] }
      : path.includes('/notifications') ? { notifications: [], unreadCount: 0 }
      : [];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  });
  await page.goto('/login');
  const token = `e30.${Buffer.from(JSON.stringify({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  await page.evaluate((value) => {
    localStorage.setItem('accessToken', value);
    localStorage.setItem('refreshToken', 'offline-refresh-token');
  }, token);
  received.attachments[0].preview_url = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    canvas.getContext('2d').fillRect(0, 0, 160, 90); return canvas.toDataURL('image/jpeg', 0.5);
  });
  await page.goto(`/chats/${roomId}`);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  const receivedBubble = page.locator('article').filter({ hasText: 'RECEIVED-OFFLINE-PHOTO' });
  await receivedBubble.getByRole('button', { name: 'Open received.png', exact: true }).click();
  const receivedViewer = page.getByRole('dialog', { name: 'received.png' });
  await expect(receivedViewer.getByText('Downloaded · available offline', { exact: true })).toBeVisible();
  await receivedViewer.getByRole('button', { name: 'Close', exact: true }).click();
  expect(originals).toBe(1);
  await page.locator('input[type="file"][multiple]').first().setInputFiles({ name: 'saved-photo.png', mimeType: 'image/png', buffer: png });
  const editor = page.getByRole('dialog', { name: 'Send attachment', exact: true });
  await editor.getByPlaceholder('Add a caption…').fill('FULLY-OFFLINE-MEDIA');
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator('article').filter({ hasText: 'FULLY-OFFLINE-MEDIA' }).locator('[data-message-status="queued"]')).toBeVisible();
  const before = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('conclave-files');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const result = await new Promise((resolve) => {
      const request = db.transaction('outbox').objectStore('outbox').getAll();
      request.onsuccess = () => resolve(request.result.map((item) => ({ id: item.clientId, size: item.media.blob.size })));
    });
    db.close(); return result;
  });
  expect(before).toHaveLength(1);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(async () => {
    const assets = performance.getEntriesByType('resource').map((entry) => entry.name)
      .filter((value) => new URL(value).pathname.startsWith('/assets/'));
    const matches = await Promise.all(assets.map((url) => caches.match(url, { ignoreVary: true })));
    return { controlled: Boolean(navigator.serviceWorker.controller),
      missing: assets.filter((_, index) => !matches[index]) };
  })).toEqual({ controlled: true, missing: [] });
  unreachable = true;
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  const restored = page.locator('article').filter({ hasText: 'FULLY-OFFLINE-MEDIA' });
  await expect(restored.getByRole('img', { name: 'saved-photo.png', exact: true })).toBeVisible();
  await expect(restored.locator('[data-message-status="queued"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('refreshToken'))).toBe('offline-refresh-token');
  expect(await restored.getAttribute('class')).toBeTruthy();
  await expect(page.locator(`[data-message-id="optimistic-${before[0].id}"]`)).toBeVisible();
  expect(before[0].size).toBe(png.length);
  await expect(receivedBubble.getByText('Downloaded · available offline', { exact: true })).toBeVisible();
  await receivedBubble.getByRole('button', { name: 'Open received.png', exact: true }).click();
  await expect(receivedViewer.getByRole('img', { name: 'received.png' })).toBeVisible();
  await receivedViewer.getByRole('button', { name: 'Close', exact: true }).click();
  expect(originals).toBe(1);
  // Reopening the app at its chat-list start URL must still expose the draft's room.
  await page.goto('/chats');
  await page.getByRole('link', { name: /Offline Room/ }).click();
  await expect(page.locator('article').filter({ hasText: 'FULLY-OFFLINE-MEDIA' })
    .getByRole('img', { name: 'saved-photo.png', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const requests = await (await caches.open('conclave-shell-v2')).keys();
    return requests.some((request) => new URL(request.url).pathname.startsWith('/api/'));
  })).toBe(false);
});
