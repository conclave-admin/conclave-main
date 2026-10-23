import { test, expect } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
async function fixture(page, attachment) {
  await page.goto("/chats");
  await expect(
    page.locator('a[href="/chats/preview-room"]').first(),
  ).toBeVisible();
  await page.evaluate(async (attachment) => {
    const { previewMessages } = await import("/src/config/devPreview.js");
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 60;
    canvas.getContext("2d").fillRect(0, 0, 100, 60);
    previewMessages.splice(0, previewMessages.length, {
      id: "30000000-0000-4000-8000-000000000031",
      room_id: "preview-room",
      sender_id: "peer",
      sender_name: "Forward Sender",
      content: "FOLLOWUP-SOURCE",
      created_at: new Date().toISOString(),
      reactions: [],
      pins: { mine: [], room: null },
      attachments: attachment
        ? [
            {
              ...attachment,
              preview_url: canvas.toDataURL("image/jpeg", 0.5),
              width: 100,
              height: 60,
            },
          ]
        : [],
    });
  }, attachment);
  await page.locator('a[href="/chats/preview-room"]').first().click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
}
test.beforeEach(async ({}, info) =>
  test.skip(
    !info.project.name.startsWith("app-"),
    "uses authenticated fixture",
  ),
);

test("forwarding media queues offline and sends references without an upload", async ({
  page,
  context,
}, info) => {
  let uploads = 0;
  await page.route("**/upload", (route) => {
    uploads++;
    return route.abort();
  });
  await fixture(page, {
    id: "40000000-0000-4000-8000-000000000031",
    filename: "forward.png",
    url: "r2://private/immutable",
    mime_type: "image/png",
    size: png.length,
  });
  await page.evaluate(async () => {
    const { previewSocket, previewMessages } =
      await import("/src/config/devPreview.js");
    const emit = previewSocket.emit.bind(previewSocket);
    window.forwardPayloads = [];
    previewSocket.emit = (event, payload, ack) => {
      if (event === "send-message" && payload.forwardSource) {
        window.forwardPayloads.push(payload);
        const source = previewMessages.find(
          (row) => row.id === payload.forwardSource.messageId,
        );
        return emit(
          event,
          {
            ...payload,
            content: source.content,
            attachments: source.attachments.map((item) => ({
              ...item,
              id: crypto.randomUUID(),
            })),
          },
          ack,
        );
      }
      return emit(event, payload, ack);
    };
  });
  const message = page
    .locator("article")
    .filter({ hasText: "FOLLOWUP-SOURCE" });
  if (info.project.name === "app-mobile")
    await message
      .locator("img")
      .dispatchEvent("contextmenu", { bubbles: true });
  else {
    await message.hover();
    await message
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  }
  await page.getByRole("menuitem", { name: "Forward", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Forward message",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: /^Forward to / }).first(),
  ).toBeVisible();
  await context.setOffline(true);
  await dialog
    .getByRole("button", { name: "Forward to Victor", exact: true })
    .click();
  await expect(page).toHaveURL(/\/chats\/preview-dm$/);
  const forwarded = page
    .locator("article")
    .filter({ hasText: "Forwarded" })
    .filter({ hasText: "FOLLOWUP-SOURCE" });
  await expect(
    forwarded.locator('[data-message-status="queued"]'),
  ).toBeVisible();
  await expect(
    forwarded.getByRole("img", { name: "forward.png", exact: true }),
  ).toBeVisible();
  expect(uploads).toBe(0);
  expect(await page.evaluate(() => window.forwardPayloads.length)).toBe(0);
  await context.setOffline(false);
  await expect(forwarded.locator("[data-outbox-state]")).toHaveCount(0);
  const sent = await page.evaluate(() => window.forwardPayloads);
  expect(sent).toHaveLength(1);
  expect(sent[0].attachments).toEqual([]);
  expect(sent[0].forwardSource.messageId).toBe(
    "30000000-0000-4000-8000-000000000031",
  );
  expect(uploads).toBe(0);
});

test("automatic downloads follow network changes while manual downloads remain available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const connection = new EventTarget();
    Object.assign(connection, {
      type: "cellular",
      effectiveType: "4g",
      saveData: false,
    });
    window.testConnection = connection;
    Object.defineProperty(navigator, "connection", {
      value: connection,
      configurable: true,
    });
    localStorage.setItem(
      "conclave-media-preferences",
      JSON.stringify({
        documents: true,
        video: false,
        network: "unmetered",
        respectSaveData: true,
      }),
    );
  });
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/attachments/network-doc", async (route) => {
    requests++;
    await gate;
    await route
      .fulfill({ contentType: "application/pdf", body: png })
      .catch(() => {});
  });
  await fixture(page, {
    id: "network-doc",
    filename: "network.pdf",
    url: "r2://private/network",
    mime_type: "application/pdf",
    size: png.length,
  });
  const message = page
    .locator("article")
    .filter({ hasText: "FOLLOWUP-SOURCE" });
  await expect(
    message.getByText("Original not downloaded", { exact: true }),
  ).toBeVisible();
  expect(requests).toBe(0);
  await page.evaluate(() => {
    testConnection.type = "wifi";
    testConnection.dispatchEvent(new Event("change"));
  });
  await expect.poll(() => requests).toBe(1);
  await expect(
    message.locator('[data-download-state="downloading"]'),
  ).toBeVisible();
  await page.evaluate(() => {
    testConnection.type = "cellular";
    testConnection.dispatchEvent(new Event("change"));
  });
  await expect(
    message.locator('[data-download-state="available"]'),
  ).toBeVisible();
  const saved = page.waitForEvent("download");
  await message
    .getByRole("button", { name: "Download network.pdf", exact: true })
    .click();
  await expect.poll(() => requests).toBe(2);
  await page.evaluate(() => {
    testConnection.saveData = true;
    testConnection.dispatchEvent(new Event("change"));
  });
  release();
  await saved;
  await expect(
    message.getByText("Downloaded · available offline", { exact: true }),
  ).toBeVisible();
  expect(requests).toBe(2);
});

test("large videos show a clear limit and optional local video compression preserves captions", async ({
  page,
}) => {
  await fixture(page, null);
  await page.getByRole("textbox", { name: "Message", exact: true }).click();
  const encoded = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(24);
    const audio = new AudioContext();
    await audio.resume();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    destination.stream
      .getAudioTracks()
      .forEach((track) => stream.addTrack(track));
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8,opus",
      videoBitsPerSecond: 10000000,
    });
    const chunks = [];
    const done = new Promise((resolve) => {
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = resolve;
    });
    recorder.start(100);
    const timer = setInterval(() => {
      const pixels = ctx.createImageData(640, 360);
      crypto.getRandomValues(pixels.data.subarray(0, 65536));
      for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
      ctx.putImageData(pixels, 0, 0);
    }, 40);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    clearInterval(timer);
    recorder.stop();
    await done;
    stream.getTracks().forEach((track) => track.stop());
    await audio.close();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(new Blob(chunks, { type: "video/webm" }));
    });
  });
  await page
    .locator('input[type="file"][multiple]')
    .first()
    .setInputFiles({
      name: "compress-me.webm",
      mimeType: "video/webm",
      buffer: Buffer.from(encoded, "base64"),
    });
  const editor = page.getByRole("dialog", {
    name: "Send attachment",
    exact: true,
  });
  await editor.getByPlaceholder("Add a caption…").fill("COMPRESSED-CAPTION");
  await editor
    .getByRole("button", { name: "Compress video", exact: true })
    .click();
  await expect(editor.getByText(/Video compressed locally to/)).toBeVisible({
    timeout: 20000,
  });
  await expect(editor.getByPlaceholder("Add a caption…")).toHaveValue(
    "COMPRESSED-CAPTION",
  );
  const audioTracks = await editor
    .locator("video")
    .first()
    .evaluate(async (video) => {
      video.muted = true;
      await video.play();
      if (!video.captureStream) return null;
      const stream = video.captureStream();
      const count = stream.getAudioTracks().length;
      stream.getTracks().forEach((track) => track.stop());
      video.pause();
      return count;
    });
  if (audioTracks !== null) expect(audioTracks).toBeGreaterThanOrEqual(1);
  await expect(
    editor.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .locator('input[type="file"][multiple]')
    .first()
    .evaluate((input) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(51 * 1024 * 1024)], "oversized.webm", {
          type: "video/webm",
        }),
      );
      input.files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await expect(editor.getByText(/exceeds its send limit/)).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
});
