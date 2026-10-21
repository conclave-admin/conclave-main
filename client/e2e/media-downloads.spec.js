import { test, expect } from '@playwright/test';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(page, attachments) {
  await page.goto('/chats');
  await expect(page.locator('a[href="/chats/preview-room"]').first()).toBeVisible();
  await page.evaluate(async (items) => {
    const { previewMessages } = await import('/src/config/devPreview.js');
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d'); context.fillStyle = '#5366d8'; context.fillRect(0, 0, 160, 90);
    const preview = canvas.toDataURL('image/jpeg', 0.5);
    previewMessages.splice(0, previewMessages.length, ...items.map((attachment, i) => ({
      id: `received-${i}`, room_id: 'preview-room', sender_id: 'peer', sender_name: 'Receiver Test Peer',
      content: `RECEIVED-MEDIA-${i}`, created_at: new Date(Date.now() + i).toISOString(),
      attachments: [{ url: `r2://private/${attachment.id}`, size: 100, width: 160, height: 90,
        preview_url: preview, ...attachment }], reactions: [], pins: { mine: [], room: null },
    })));
  }, attachments);
  await page.locator('a[href="/chats/preview-room"]').first().click();
  await expect(bubble(page)).toBeVisible();
}
async function remount(page) {
  await page.evaluate(() => { history.pushState({}, '', '/chats'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.locator('a[href="/chats/preview-room"]').first()).toBeVisible();
  await page.locator('a[href="/chats/preview-room"]').first().click();
}
const bubble = (page, index = 0) => page.locator('article').filter({ hasText: `RECEIVED-MEDIA-${index}` });
test.beforeEach(async ({}, info) => test.skip(!info.project.name.startsWith('app-'), 'uses authenticated app fixture'));

test('photos preview, download on open and reopen offline from device cache', async ({ page, context }) => {
  let originals = 0;
  await page.route('**/attachments/photo-original', (route) => { originals++; return route.fulfill({ contentType: 'image/png', body: png }); });
  await fixture(page, [{ id: 'photo-original', filename: 'private-photo.png', mime_type: 'image/png' }]);
  const photo = bubble(page);
  await expect(photo.getByRole('img', { name: 'private-photo.png' })).toBeVisible(); expect(originals).toBe(0);
  const bounds = await photo.getByRole('button', { name: 'Open private-photo.png', exact: true }).boundingBox();
  expect(Math.abs(bounds.width / bounds.height - 160 / 90)).toBeLessThan(0.05);
  await photo.getByRole('button', { name: 'Open private-photo.png', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'private-photo.png' });
  await expect(viewer.getByText('Downloaded · available offline', { exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: 'Close', exact: true }).click(); expect(originals).toBe(1);
  await context.setOffline(true); await remount(page);
  await expect(photo.getByText('Downloaded · available offline', { exact: true })).toBeVisible();
  await photo.getByRole('button', { name: 'Open private-photo.png', exact: true }).click();
  await expect(viewer.getByRole('img', { name: 'private-photo.png' })).toBeVisible(); expect(originals).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('expired previews retry and cache bytes without downloading originals', async ({ page }) => {
  let previews = 0; let originals = 0; let failPreview = true;
  await page.route('**/attachments/legacy-photo', (route) => { originals++; return route.fulfill({ contentType: 'image/png', body: png }); });
  await page.route('**/attachments/legacy-photo/preview-url', (route) => {
    previews++; return route.fulfill({ json: { success: true, data: { url: `https://preview.example.test/photo?token=${previews}` } } });
  });
  await page.route('https://preview.example.test/**', (route) => route.fulfill(failPreview
    ? { status: 403, headers: { 'access-control-allow-origin': '*' }, body: 'expired' }
    : { contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png }));
  await fixture(page, [{ id: 'legacy-photo', filename: 'legacy.png', mime_type: 'image/png', preview_url: null }]);
  const retry = bubble(page).getByRole('button', { name: 'Retry preview legacy.png', exact: true });
  await expect(retry).toBeVisible(); const before = previews; failPreview = false;
  await retry.click();
  await expect(bubble(page).getByRole('img', { name: 'legacy.png', exact: true })).toBeVisible();
  expect(previews).toBe(before + 1); expect(originals).toBe(0);
  await remount(page); await expect(bubble(page).getByRole('img', { name: 'legacy.png', exact: true })).toBeVisible();
  expect(previews).toBe(before + 1); expect(originals).toBe(0);
});

test('video poster and duration, download cancellation, failure, retry and local reuse', async ({ page }) => {
  const release = gate(); let requests = 0;
  await page.route('**/attachments/video-original', async (route) => {
    requests++;
    if (requests === 1) await release.promise;
    if (requests === 2) return route.fulfill({ status: 502, json: { message: 'Try downloading again' } });
    return route.fulfill({ contentType: 'video/mp4', body: Buffer.from('test-video-bytes') }).catch(() => {});
  });
  try {
    await fixture(page, [{ id: 'video-original', filename: 'clip.mp4', mime_type: 'video/mp4', duration: 65 }]);
    const video = bubble(page); await expect(video.getByText('1:05 · 100 B')).toBeVisible();
    expect(requests).toBe(0); await expect(video.locator('video')).toHaveCount(0);
    await video.getByRole('button', { name: /^Download video / }).click();
    await expect(video.locator('[data-download-state="downloading"]')).toBeVisible();
    await expect(video.getByRole('progressbar')).toBeVisible();
    await video.getByRole('button', { name: 'Cancel download clip.mp4', exact: true }).click();
    await expect(video.locator('[data-download-state="available"]')).toBeVisible(); release.resolve();
    await video.getByRole('button', { name: /^Download video / }).click();
    await expect(video.getByText('Download failed', { exact: true })).toBeVisible();
    await video.getByRole('button', { name: 'Retry download clip.mp4', exact: true }).click();
    await expect(video.getByText('Downloaded · available offline', { exact: true })).toBeVisible(); expect(requests).toBe(3);
    await remount(page); await expect(video.getByText('Downloaded · available offline', { exact: true })).toBeVisible(); expect(requests).toBe(3);
  } finally { release.resolve(); }
});

test('manual documents cache with auto-download off; clearing cache removes downloaded state', async ({ page }) => {
  let requests = 0;
  await page.route('**/attachments/document-original', (route) => { requests++; return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\nexample' }); });
  await fixture(page, [{ id: 'document-original', filename: 'notes.pdf', mime_type: 'application/pdf', preview_url: null, width: null, height: null }]);
  const document = bubble(page); expect(requests).toBe(0);
  await document.getByRole('button', { name: 'Download notes.pdf', exact: true }).click();
  await expect(document.getByText('Downloaded · available offline', { exact: true })).toBeVisible();
  await remount(page); await expect(document.getByText('Downloaded · available offline', { exact: true })).toBeVisible(); expect(requests).toBe(1);
  // Refreshing tokens in another tab for the same account must retain media state.
  await page.evaluate(() => dispatchEvent(new StorageEvent('storage', { key: 'accessToken' })));
  await expect(document.getByText('Downloaded · available offline', { exact: true })).toBeVisible();
  await page.evaluate(async () => { const { clearLocalFiles } = await import('/src/lib/fileCache.js'); await clearLocalFiles(); });
  await expect(document.getByText('Original not downloaded', { exact: true })).toBeVisible();
  await document.getByRole('button', { name: 'Download notes.pdf', exact: true }).click();
  await expect(document.getByText('Downloaded · available offline', { exact: true })).toBeVisible(); expect(requests).toBe(2);
});

test('auto-download loads video and documents but photos remain previews', async ({ page }) => {
  const requested = [];
  await page.addInitScript(() => localStorage.setItem('conclave-media-preferences', JSON.stringify({ video: true, documents: true })));
  await page.route('**/attachments/auto-*', (route) => {
    requested.push(new URL(route.request().url()).pathname.split('/').at(-1));
    return route.fulfill({ contentType: 'application/octet-stream', body: 'test-original' });
  });
  await fixture(page, [
    { id: 'auto-video', filename: 'auto.mp4', mime_type: 'video/mp4' },
    { id: 'auto-document', filename: 'auto.txt', mime_type: 'text/plain', preview_url: null },
    { id: 'auto-photo', filename: 'auto.png', mime_type: 'image/png' },
  ]);
  await expect.poll(() => requested.length).toBe(2); expect(requested.sort()).toEqual(['auto-document', 'auto-video']);
  await expect(bubble(page, 1).getByText('Downloaded · available offline', { exact: true })).toBeVisible();
  await expect(bubble(page, 2).getByText('Original not downloaded', { exact: true })).toBeVisible();
});

test('sender generates bounded photo thumbnails and video poster metadata', async ({ page }) => {
  await page.goto('/chats/preview-room');
  const metadata = await page.evaluate(async () => {
    const { generateMediaMetadata } = await import('/src/lib/mediaMetadata.js');
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d'); context.fillStyle = '#2688b0'; context.fillRect(0, 0, 640, 360);
    const photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const result = { photo: await generateMediaMetadata(photo) };
    if (typeof MediaRecorder !== 'undefined') {
      const stream = canvas.captureStream(10); const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }); const chunks = [];
      const stopped = new Promise((resolve) => { recorder.ondataavailable = (e) => chunks.push(e.data); recorder.onstop = resolve; });
      recorder.start();
      for (let frame = 0; frame < 6; frame++) { context.fillStyle = frame % 2 ? '#123456' : '#abcdef'; context.fillRect(0, 0, 640, 360); await new Promise((resolve) => setTimeout(resolve, 100)); }
      recorder.stop(); await stopped; stream.getTracks().forEach((track) => track.stop());
      result.video = await generateMediaMetadata(new Blob(chunks, { type: 'video/webm' }));
    }
    return result;
  });
  expect(metadata.photo.width).toBe(640); expect(metadata.photo.height).toBe(360);
  expect(metadata.photo.preview_url).toMatch(/^data:image\/jpeg;base64,/); expect(metadata.photo.preview_url.length).toBeLessThanOrEqual(16407);
  if (metadata.video) { expect(metadata.video.width).toBe(640); expect(metadata.video.height).toBe(360); expect(metadata.video.duration).toBeGreaterThan(0); expect(metadata.video.preview_url).toMatch(/^data:image\/jpeg;base64,/); }
});
