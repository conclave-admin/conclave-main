import { test, expect } from '@playwright/test';

// Real composer, IndexedDB, upload HTTP client and outbox worker; private R2
// requests are mocked. The preview socket supplies normal message acknowledgements.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const file = (name) => ({ name, mimeType: 'image/png', buffer: png });
const gate = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function open(page) {
  await page.goto('/chats/preview-room');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({ timeout: 20000 });
  await page.evaluate(async () => {
    const { previewSocket } = await import('/src/config/devPreview.js');
    window.mediaDraftCache = await import('/src/lib/fileCache.js');
    const emit = previewSocket.emit.bind(previewSocket);
    window.mediaSends = [];
    previewSocket.emit = (event, payload, acknowledge) => {
      if (event === 'send-message') {
        window.mediaSends.push(payload);
        if (window.rejectNextMediaSend) {
          window.rejectNextMediaSend = false;
          acknowledge({ ok: false, error: 'Message delivery temporarily rejected' });
          return;
        }
      }
      return emit(event, payload, acknowledge);
    };
  });
}
async function drafts(page, userId) {
  return page.evaluate(async (accountId) => {
    const { listOutbox } = window.mediaDraftCache || await import('/src/lib/fileCache.js');
    const { previewUser } = await import('/src/config/devPreview.js');
    return Promise.all((await listOutbox(accountId || previewUser.id)).map(async (item) => ({
      key: item.key, clientId: item.clientId, state: item.state,
      albumId: item.payload.albumId, caption: item.payload.content,
      url: item.payload.attachments?.[0]?.url,
      size: item.media?.blob.size, filename: item.media?.filename,
    })));
  }, userId);
}
async function select(page, names) {
  await page.locator('input[type="file"][multiple]').first().setInputFiles(names.map(file));
  const editor = page.getByRole('dialog', { name: 'Send attachment', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}
async function uploaded(route, number) {
  return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
    success: true, data: { url: `r2://private/test-${number}.png`, filename: `test-${number}.png`,
      mime_type: 'image/png', size: png.length, width: 1, height: 1, preview_url: null },
  }) });
}

test.beforeEach(async ({ page }, info) => {
  await page.route('**/upload/capabilities', (route) => route.fulfill({ json: { success: true, data: { multipart: false } } }));
  test.skip(!info.project.name.startsWith('app-'), 'requires the signed-in preview fixture');
});

test('media bubbles appear from local files before upload and continue after leaving the room', async ({ page }) => {
  const release = gate(); let requests = 0;
  await page.route('**/upload', async (route) => {
    const number = ++requests;
    await release.promise;
    await uploaded(route, number);
  });
  try {
    await open(page);
    const editor = await select(page, ['first.png', 'second.png']);
    await editor.getByPlaceholder('Add a caption…').fill('FIRST-ALBUM-CAPTION');
    await editor.getByRole('button', { name: 'Preview second.png', exact: true }).click();
    await editor.getByPlaceholder('Add a caption…').fill('SECOND-ALBUM-CAPTION');
    await editor.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(editor).not.toBeVisible();
    const first = page.locator('article').filter({ hasText: 'FIRST-ALBUM-CAPTION' });
    const second = page.locator('article').filter({ hasText: 'SECOND-ALBUM-CAPTION' });
    await expect(first.getByRole('img', { name: 'first.png', exact: true })).toBeVisible();
    await expect(first.locator('[data-outbox-state="uploading"]')).toBeVisible();
    await expect(second.locator('[data-message-status="queued"]')).toBeVisible();
    const saved = await drafts(page);
    expect(saved).toHaveLength(2);
    expect(saved.every((item) => item.size === png.length)).toBeTruthy();
    expect(saved[0].albumId).toMatch(/^[a-f\d-]{36}$/i);
    expect(saved[0].albumId).toBe(saved[1].albumId);
    expect(await page.evaluate(() => window.mediaSends.length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const back = page.getByRole('link', { name: 'Back to chats', exact: true });
    if (await back.isVisible()) await back.click();
    else await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Chats', exact: true }).click();
    release.resolve();
    await expect.poll(() => page.evaluate(() => window.mediaSends.length)).toBe(2);
    const sends = await page.evaluate(() => window.mediaSends);
    expect(sends[0].albumId).toBe(saved[0].albumId);
    expect(sends[1].albumId).toBe(saved[0].albumId);
    expect(sends.map((item) => item.content)).toEqual(['FIRST-ALBUM-CAPTION', 'SECOND-ALBUM-CAPTION']);
    expect(sends.every((item) => item.attachments.length === 1 && !item.media && !item.attachments[0].local_blob)).toBeTruthy();
    await expect.poll(() => drafts(page)).toEqual([]);
    await page.goBack();
    await expect(page.locator('article').filter({ hasText: 'FIRST-ALBUM-CAPTION' })).toHaveCount(1);
    await expect(page.locator('article').filter({ hasText: 'SECOND-ALBUM-CAPTION' })).toHaveCount(1);
  } finally { release.resolve(); }
});

test('offline files and captions survive a refresh and send after reconnection', async ({ page, context }) => {
  let requests = 0;
  await page.route('**/upload', (route) => uploaded(route, ++requests));
  // Keep the outbox paused across reload while allowing Vite to load the app.
  // The actual offline send below also runs with network access disabled.
  await open(page);
  await page.addInitScript(() => {
    window.outboxOffline = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !window.outboxOffline });
  });
  const editor = await select(page, ['offline.png']);
  await editor.getByPlaceholder('Add a caption…').fill('OFFLINE-MEDIA-CAPTION');
  await context.setOffline(true);
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator('article').filter({ hasText: 'OFFLINE-MEDIA-CAPTION' }).locator('[data-message-status="queued"]')).toBeVisible();
  const saved = await drafts(page);
  expect(requests).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  await context.setOffline(false);
  await page.reload();
  const restored = page.locator('article').filter({ hasText: 'OFFLINE-MEDIA-CAPTION' });
  await expect(restored.getByRole('img', { name: 'offline.png', exact: true })).toBeVisible();
  expect((await drafts(page))[0].clientId).toBe(saved[0].clientId);
  expect((await drafts(page))[0].size).toBe(png.length);
  expect(requests).toBe(0);
  await page.evaluate(() => { window.outboxOffline = false; window.dispatchEvent(new Event('online')); });
  await expect.poll(() => requests).toBe(1);
  await expect.poll(() => drafts(page)).toEqual([]);
  await expect(restored).toHaveCount(1);
  await expect(restored.locator('[data-outbox-state]')).toHaveCount(0);
});

test('a real authenticated session restores pending media when the API becomes unreachable', async ({ page }) => {
  const user = { id: '10000000-0000-4000-8000-000000000001', display_name: 'Offline User', email: 'offline@example.test' };
  const roomId = '20000000-0000-4000-8000-000000000001';
  const room = { id: roomId, name: 'Offline Recovery Room', display_name: 'Offline Recovery Room', type: 'group',
    my_role: 'admin', members: [{ ...user, role: 'admin' }], member_count: 1 };
  let unreachable = false;
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', (route) => {
    if (unreachable) return route.abort();
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/users/me') ? user
      : path.endsWith(`/rooms/${roomId}`) ? room
      : path.endsWith('/rooms') ? [room]
      : path.includes('/messages/') ? { messages: [], nextCursor: null }
      : path.includes('/decisions') ? { decisions: [] }
      : path.includes('/notifications') ? { notifications: [], unreadCount: 0 }
      : [];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  });
  await page.goto('http://localhost:5174/login');
  const token = `e30.${Buffer.from(JSON.stringify({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  await page.evaluate(({ token }) => {
    localStorage.setItem('accessToken', token);
    localStorage.setItem('refreshToken', 'retained-refresh-token');
  }, { token });
  await page.goto(`http://localhost:5174/chats/${roomId}`);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({ timeout: 20000 });
  const editor = await select(page, ['real-offline.png']);
  await editor.getByPlaceholder('Add a caption…').fill('REAL-SESSION-OFFLINE-DRAFT');
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const before = await drafts(page, user.id);
  expect(before).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('conclave.session-user')).id)).toBe(user.id);
  unreachable = true;
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible({ timeout: 20000 });
  const bubble = page.locator('article').filter({ hasText: 'REAL-SESSION-OFFLINE-DRAFT' });
  await expect(bubble.getByRole('img', { name: 'real-offline.png', exact: true })).toBeVisible();
  await expect(bubble.locator('[data-message-status="queued"]')).toBeVisible();
  const after = await drafts(page, user.id);
  expect(after[0].clientId).toBe(before[0].clientId);
  expect(after[0].size).toBe(png.length);
  expect(await page.evaluate(() => localStorage.getItem('refreshToken'))).toBe('retained-refresh-token');
});

test('a message failure after upload HTTP 201 retries the existing upload', async ({ page }) => {
  let requests = 0;
  await page.route('**/upload', (route) => uploaded(route, ++requests));
  await open(page);
  await page.evaluate(() => { window.rejectNextMediaSend = true; });
  const editor = await select(page, ['retry.png']);
  await editor.getByPlaceholder('Add a caption…').fill('RETRY-MESSAGE-AFTER-UPLOAD');
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  const bubble = page.locator('article').filter({ hasText: 'RETRY-MESSAGE-AFTER-UPLOAD' });
  await expect(bubble.locator('[data-outbox-state="failed"]')).toBeVisible();
  const before = await drafts(page);
  expect(before[0].url).toBe('r2://private/test-1.png');
  await bubble.getByRole('button', { name: /^Retry / }).click();
  await expect.poll(() => drafts(page)).toEqual([]);
  const sends = await page.evaluate(() => window.mediaSends);
  expect(requests).toBe(1);
  expect(sends).toHaveLength(2);
  expect(sends[0].clientId).toBe(sends[1].clientId);
  expect(sends[1].attachments[0].url).toBe(before[0].url);
  await expect(bubble).toHaveCount(1);
  await expect(bubble.locator('[data-outbox-state]')).toHaveCount(0);
});

test('cancel stops an active upload and prevents a late message', async ({ page }) => {
  const release = gate(); let requests = 0;
  await page.route('**/upload', async (route) => {
    requests += 1;
    await release.promise;
    await uploaded(route, 1).catch(() => {});
  });
  try {
    await open(page);
    const editor = await select(page, ['cancel.png']);
    await editor.getByPlaceholder('Add a caption…').fill('CANCELLED-UPLOAD-CAPTION');
    await editor.getByRole('button', { name: 'Send', exact: true }).click();
    const bubble = page.locator('article').filter({ hasText: 'CANCELLED-UPLOAD-CAPTION' });
    await expect.poll(() => requests).toBe(1);
    await bubble.getByRole('button', { name: /^Cancel upload / }).click();
    await expect(bubble).toHaveCount(0);
    release.resolve();
    await expect.poll(() => drafts(page)).toEqual([]);
    expect(await page.evaluate(() => window.mediaSends.length)).toBe(0);
  } finally { release.resolve(); }
});

test('storage failure keeps the editor, captions and files and starts no upload', async ({ page }) => {
  let requests = 0;
  await page.route('**/upload', (route) => uploaded(route, ++requests));
  await page.addInitScript(() => {
    window.blockDraftWrites = true;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names, mode, ...args) {
      if (window.blockDraftWrites && mode === 'readwrite' && [names].flat().includes('outbox')) {
        throw new DOMException('Device storage is full', 'QuotaExceededError');
      }
      return transaction.call(this, names, mode, ...args);
    };
  });
  await open(page);
  const editor = await select(page, ['preserved.png']);
  await editor.getByPlaceholder('Add a caption…').fill('PRESERVED-CAPTION');
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Could not save this message on your device');
  await expect(editor.getByPlaceholder('Add a caption…')).toHaveValue('PRESERVED-CAPTION');
  await expect(editor.getByRole('img', { name: 'preserved.png', exact: true })).toBeVisible();
  expect(requests).toBe(0);
  expect(await drafts(page)).toHaveLength(0);
  await page.evaluate(() => { window.blockDraftWrites = false; });
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.mediaSends.length)).toBe(1);
});

test('retry after a partial album failure only sends the remaining item', async ({ page }) => {
  let requests = 0;
  await page.route('**/upload', (route) => {
    requests += 1;
    if (requests === 2) return route.fulfill({ status: 415, contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'Temporary test file rejection' }) });
    return uploaded(route, requests);
  });
  await open(page);
  const editor = await select(page, ['one.png', 'two.png']);
  await editor.getByPlaceholder('Add a caption…').fill('PARTIAL-ALBUM-ONE');
  await editor.getByRole('button', { name: 'Preview two.png', exact: true }).click();
  await editor.getByPlaceholder('Add a caption…').fill('PARTIAL-ALBUM-TWO');
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  const second = page.locator('article').filter({ hasText: 'PARTIAL-ALBUM-TWO' });
  await expect(second.locator('[data-outbox-state="failed"]')).toBeVisible();
  const pending = await drafts(page);
  expect(pending).toHaveLength(1);
  expect(pending[0].size).toBe(png.length);
  const firstSend = await page.evaluate(() => window.mediaSends[0]);
  expect(pending[0].albumId).toBe(firstSend.albumId);
  await second.getByRole('button', { name: /^Retry / }).click();
  await expect.poll(() => page.evaluate(() => window.mediaSends.length)).toBe(2);
  const sends = await page.evaluate(() => window.mediaSends);
  expect(sends[1].clientId).toBe(pending[0].clientId);
  expect(sends[1].albumId).toBe(sends[0].albumId);
  expect(requests).toBe(3);
  await expect.poll(() => drafts(page)).toEqual([]);
  await expect(page.locator('article').filter({ hasText: 'PARTIAL-ALBUM-ONE' })).toHaveCount(1);
  await expect(second).toHaveCount(1);
});

test('a failure while saving the second file rolls back the entire selected batch', async ({ page }) => {
  let uploads = 0;
  await page.route('**/upload', (route) => uploaded(route, ++uploads));
  await page.addInitScript(() => {
    const add = IDBObjectStore.prototype.add;
    let writes = 0;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'outbox' && ++writes === 2) throw new DOMException('Second file could not be saved', 'QuotaExceededError');
      return add.apply(this, args);
    };
  });
  await open(page);
  const editor = await select(page, ['atomic-one.png', 'atomic-two.png']);
  await editor.getByPlaceholder('Add a caption…').fill('ATOMIC-CAPTION-ONE');
  await editor.getByRole('button', { name: 'Preview atomic-two.png', exact: true }).click();
  await editor.getByPlaceholder('Add a caption…').fill('ATOMIC-CAPTION-TWO');
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Second file could not be saved');
  await expect.poll(() => drafts(page)).toEqual([]);
  expect(uploads).toBe(0);
  expect(await page.evaluate(() => window.mediaSends.length)).toBe(0);
  await expect(editor.getByPlaceholder('Add a caption…')).toHaveValue('ATOMIC-CAPTION-TWO');
  await editor.getByRole('button', { name: 'Preview atomic-one.png', exact: true }).click();
  await expect(editor.getByPlaceholder('Add a caption…')).toHaveValue('ATOMIC-CAPTION-ONE');
});

test('failed uploads show the server reason and retry only after an explicit request', async ({ page }) => {
  let requests = 0;
  await page.route('**/upload', (route) => {
    if (++requests === 1) return route.fulfill({ status: 503, json: { success: false, message: 'Storage service is temporarily unavailable' } });
    return uploaded(route, requests);
  });
  await open(page);
  const editor = await select(page, ['manual-retry.png']);
  await editor.getByPlaceholder('Add a caption…').fill('MANUAL-UPLOAD-RETRY');
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  const message = page.locator('article').filter({ hasText: 'MANUAL-UPLOAD-RETRY' });
  await expect(message.locator('[data-outbox-state="failed"]')).toBeVisible();
  await expect(message.getByText('Storage service is temporarily unavailable', { exact: true })).toBeVisible();
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.evaluate(() => { history.pushState({}, '', '/chats'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.locator('a[href="/chats/preview-room"]').first().click();
  await expect(message.locator('[data-outbox-state="failed"]')).toBeVisible();
  expect(requests).toBe(1);
  await message.getByRole('button', { name: /^Retry / }).click();
  await expect.poll(() => drafts(page)).toEqual([]);
  expect(requests).toBe(2);
  await expect(message).toHaveCount(1);
});
