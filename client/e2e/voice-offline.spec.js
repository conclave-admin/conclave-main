import { test, expect } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
function wav() {
  const rate = 8000,
    count = rate * 5,
    data = Buffer.alloc(44 + count * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++)
    data.writeInt16LE(
      Math.round(
        Math.sin((i * 2 * Math.PI * 300) / rate) *
          (0.1 + 0.4 * Math.abs(Math.sin(i / rate))) *
          30000,
      ),
      44 + i * 2,
    );
  return data;
}
async function open(page) {
  await page.goto("/chats");
  await page.getByRole("list", { name: "Conversations" }).waitFor();
  await page.evaluate(async () => {
    const { previewMessages } = await import("/src/config/devPreview.js");
    previewMessages.splice(0, previewMessages.length);
  });
  await page.locator('a[href="/chats/preview-room"]').first().click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
}
async function microphone(page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = 0.2;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      await context.resume();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          context.close().catch(() => {});
        };
      }
      return destination.stream;
    };
  });
}
test("tap recording has real live levels, pause/resume and waveform preview without sending", async ({
  page,
}, info) => {
  await microphone(page);
  await open(page);
  const record = page.getByRole("button", {
    name: "Record voice note",
    exact: true,
  });
  if (info.project.use.isMobile) await record.tap();
  else await record.click();
  const pause = page.getByRole("button", {
    name: "Pause recording",
    exact: true,
  });
  await expect(pause).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".audio-waveform span")
        .evaluateAll((bars) =>
          bars.some((bar) => parseFloat(bar.style.height) > 8),
        ),
    )
    .toBe(true);
  await page.screenshot({
    path: `/tmp/conclave-recording-${info.project.name}.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await pause.click();
  await expect(
    page.getByRole("button", { name: "Resume recording", exact: true }),
  ).toBeVisible();
  const time = await page.locator(".composer-pill time").textContent();
  await page.waitForTimeout(1100);
  await expect(page.locator(".composer-pill time")).toHaveText(time);
  await page
    .getByRole("button", { name: "Resume recording", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Stop voice note recording", exact: true })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Send attachment",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await preview
    .getByRole("button", { name: "Play Voice message", exact: true })
    .click();
  await expect(
    preview.getByRole("slider", { name: "Seek Voice message", exact: true }),
  ).toBeEnabled();
  await preview
    .getByRole("button", { name: "Discard voice message", exact: true })
    .click();
  await expect(preview).toBeHidden();
});
test("holding supports slide-to-cancel and slide-to-lock without accidental sends", async ({
  page,
}) => {
  await microphone(page);
  await open(page);
  let button = page.getByRole("button", {
    name: "Record voice note",
    exact: true,
  });
  let box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(
    page.getByRole("button", {
      name: "Stop voice note recording",
      exact: true,
    }),
  ).toBeVisible();
  await page.mouse.move(box.x - 100, box.y + box.height / 2);
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Record voice note", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(
    page.getByRole("button", {
      name: "Stop voice note recording",
      exact: true,
    }),
  ).toBeVisible();
  await page.mouse.move(box.x + box.width / 2, box.y - 100);
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Pause recording", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Discard recording", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("unlocked hold release saves a voice note to the offline outbox", async ({
  page,
  context,
}) => {
  await microphone(page);
  await open(page);
  await context.setOffline(true);
  const box = await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(
    page.getByRole("button", {
      name: "Stop voice note recording",
      exact: true,
    }),
  ).toBeVisible();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Record voice note", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { listOutbox } = await import("/src/lib/fileCache.js");
        return (await listOutbox("dev-preview-user")).some((item) =>
          item.media?.filename?.startsWith("voice-note-"),
        );
      }),
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("originals download quietly and images, documents and audio remain usable offline", async ({
  page,
  context,
}, info) => {
  let originals = 0;
  await page.route("**/attachments/quiet-*", (route) => {
    originals++;
    const url = route.request().url();
    return route.fulfill(
      url.endsWith("quiet-audio")
        ? { contentType: "audio/wav", body: wav() }
        : url.endsWith("quiet-document")
          ? { contentType: "text/plain", body: "Offline document content" }
          : { contentType: "image/png", body: png },
    );
  });
  await page.goto("/chats");
  await page.getByRole("list", { name: "Conversations" }).waitFor();
  const populate = async () =>
    page.evaluate(async () => {
      const { previewMessages } = await import("/src/config/devPreview.js");
      previewMessages.splice(
        0,
        previewMessages.length,
        ...[
          { id: "quiet-image", filename: "quiet.png", mime_type: "image/png" },
          {
            id: "quiet-document",
            filename: "notes.txt",
            mime_type: "text/plain",
          },
          {
            id: "quiet-audio",
            filename: "voice-note-quiet.wav",
            mime_type: "audio/wav",
          },
        ].map((attachment, index) => ({
          id: `quiet-message-${index}`,
          room_id: "preview-room",
          sender_id: "dev-victor",
          sender_name: "Victor",
          content: "",
          created_at: new Date().toISOString(),
          attachments: [
            { ...attachment, url: `r2://private/${attachment.id}`, size: 100 },
          ],
          reactions: [],
          pins: { mine: [], room: null },
        })),
      );
    });
  await populate();
  await page.locator('a[href="/chats/preview-room"]').first().click();
  await expect.poll(() => originals).toBe(3);
  await expect(page.locator('[data-media-offline="true"]')).toHaveCount(3);
  await expect(
    page
      .locator('article [role="status"]')
      .filter({ hasText: /Downloading|Downloaded/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      /Available this visit|could not save offline|Downloaded · available offline/,
    ),
  ).toHaveCount(0);
  await page.screenshot({
    path: `/tmp/conclave-quiet-downloads-${info.project.name}.png`,
  });
  await page.goto("/chats");
  await populate();
  await page.locator('a[href="/chats/preview-room"]').first().click();
  await expect(
    page.getByRole("button", { name: "Open notes.txt", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-media-offline="true"]')).toHaveCount(3);
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Open notes.txt", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "notes.txt", exact: true }),
  ).toContainText("Offline document content");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Play Voice message", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause Voice message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("slider", { name: "Seek Voice message", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page
        .locator(".audio-waveform span")
        .evaluateAll(
          (bars) => new Set(bars.map((bar) => bar.style.height)).size,
        ),
    )
    .toBeGreaterThan(2);
  await page
    .getByRole("button", { name: "Open quiet.png", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "quiet.png", exact: true })
      .getByRole("img", { name: "quiet.png", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog", { name: "quiet.png", exact: true })
      .getByText(
        /Original not downloaded|Available this visit|Downloaded · available offline/,
      ),
  ).toHaveCount(0);
  const viewer = page.getByRole("dialog", { name: "quiet.png", exact: true });
  await expect(viewer.getByRole("progressbar")).toHaveCount(0);
  await viewer.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", { name: "Open quiet.png", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "quiet.png", exact: true })
      .locator('[data-media-offline="true"]'),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("audio").evaluate((audio) => audio.pause());
  await page
    .getByRole("button", { name: "Play Voice message", exact: true })
    .click();
  expect(originals).toBe(3);
});

test("retention keeps completed originals beyond the disposable cache budget", async ({
  page,
}) => {
  await page.goto("/chats");
  const result = await page.evaluate(async () => {
    const { saveLocalFile, readLocalFile } = await import(
      "/src/lib/fileCache.js"
    );
    const original = "media:preview:retained-original";
    const preview = "media:preview:preview-v1:disposable";
    await saveLocalFile(original, new Blob(["retained bytes"]));
    await saveLocalFile(preview, new Blob(["preview bytes"]));
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("conclave-files", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // Exercise large metadata accounting without allocating hundreds of MB in CI.
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("meta", "readwrite");
      for (const key of [original, preview])
        transaction
          .objectStore("meta")
          .put({ key, size: 300 * 1024 * 1024, lastUsed: 0 });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    await saveLocalFile(
      "media:preview:second-original",
      new Blob(["second bytes"]),
    );
    return {
      original: await (await readLocalFile(original))?.text(),
      preview: Boolean(await readLocalFile(preview)),
    };
  });
  expect(result).toEqual({ original: "retained bytes", preview: false });
});

test("interrupted hold stops into preview and a late release cannot send it", async ({
  page,
}) => {
  await microphone(page);
  await open(page);
  const button = page.getByRole("button", {
    name: "Record voice note",
    exact: true,
  });
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(
    page.getByRole("button", {
      name: "Stop voice note recording",
      exact: true,
    }),
  ).toBeVisible();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const mic = document.querySelector(
      '[aria-label="Stop voice note recording"]',
    );
    window.dispatchEvent(new Event("blur"));
    mic.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }),
    );
  });
  await page.mouse.up();
  await expect(
    page.getByRole("dialog", { name: "Send attachment", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const { listOutbox } = await import("/src/lib/fileCache.js");
      return (await listOutbox("dev-preview-user")).length;
    }),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Discard voice message", exact: true })
    .click();
  const mic = page.getByRole("button", {
    name: "Record voice note",
    exact: true,
  });
  await mic.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Pause recording", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await page
    .getByRole("button", { name: "Stop voice note recording", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Send attachment", exact: true }),
  ).toBeVisible();
});
