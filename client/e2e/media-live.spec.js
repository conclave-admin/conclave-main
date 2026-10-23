import { test, expect } from "@playwright/test";
const API = "http://localhost:7100/api";
async function account(request, suffix) {
  const response = await request.post(`${API}/auth/register`, {
    data: {
      email: `media-live-${suffix}-${Date.now()}@example.test`,
      password: "LiveMediaTest42!",
      displayName: `Media ${suffix}`,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data;
}
async function login(page, account) {
  await page.goto("/login");
  await page.evaluate((account) => {
    localStorage.setItem("accessToken", account.accessToken);
    localStorage.setItem("refreshToken", account.refreshToken);
  }, account);
}
test("real private R2 sender/receiver media, downloads and deletion access", async ({
  page,
  browser,
  request,
}, info) => {
  test.skip(
    !info.project.name.startsWith("live-"),
    "requires explicit real-R2 configuration",
  );
  const sender = await account(request, `${info.project.name}-sender`);
  const receiver = await account(request, `${info.project.name}-receiver`);
  const outsider = await account(request, `${info.project.name}-outsider`);
  const auth = (token) => ({ authorization: `Bearer ${token}` });
  // This suite exercises R2 transforms and server upload validation. Device
  // encryption has its own real-API suite and deliberately bypasses transforms.
  const created = await request.post(`${API}/rooms`, {
    headers: auth(sender.accessToken),
    data: {
      type: "group",
      name: "Private R2 access fixture",
      memberIds: [receiver.user.id],
    },
  });
  expect(created.status()).toBe(201);
  const room = (await created.json()).data;
  await login(page, sender);
  await page.goto(`/chats/${room.id}`);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).click();
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#7955cf";
    ctx.fillRect(0, 0, 640, 360);
    const photo = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8),
    );
    const stream = canvas.captureStream(15);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = [];
    const video = await new Promise((resolve) => {
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
      rec.start();
      let frame = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = frame++ % 2 ? "#4466bb" : "#8855aa";
        ctx.fillRect(0, 0, 640, 360);
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        rec.stop();
        stream.getTracks().forEach((track) => track.stop());
      }, 800);
    });
    return {
      photo: [...new Uint8Array(await photo.arrayBuffer())],
      video: [...new Uint8Array(await video.arrayBuffer())],
    };
  });
  const wav = Buffer.alloc(44 + 1600);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(1600, 40);
  const files = [
    {
      name: "live-photo.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(bytes.photo),
    },
    {
      name: "live-video.webm",
      mimeType: "video/webm",
      buffer: Buffer.from(bytes.video),
    },
    { name: "live-audio.wav", mimeType: "audio/wav", buffer: wav },
    {
      name: "live-document.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF"),
    },
  ];
  const receivedContext = await browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: Boolean(info.project.use.isMobile),
    hasTouch: Boolean(info.project.use.hasTouch),
  });
  try {
    const recipient = await receivedContext.newPage();
    await login(recipient, receiver);
    await recipient.goto(`/chats/${room.id}`);
    await expect(
      recipient.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    let lostUploadResponse = false;
    await page.route("**/api/upload", async (route) => {
      if (!lostUploadResponse) {
        lostUploadResponse = true;
        const stored = await route.fetch();
        expect(stored.status()).toBe(201);
        await route.abort("connectionreset");
      } else await route.continue();
    });
    for (const file of files) {
      await page
        .locator('input[type="file"][multiple]')
        .first()
        .setInputFiles(file);
      const editor = page.getByRole("dialog", {
        name: "Send attachment",
        exact: true,
      });
      await editor.getByPlaceholder("Add a caption…").fill(`LIVE-${file.name}`);
      await editor.getByRole("button", { name: "Send", exact: true }).click();
      if (file.name === "live-photo.jpg") {
        let pending = page
          .locator("article")
          .filter({ hasText: "LIVE-live-photo.jpg" });
        await expect(
          pending.locator('[data-outbox-state="failed"]'),
        ).toBeVisible({ timeout: 45000 });
        await expect(
          recipient
            .locator("article")
            .filter({ hasText: "LIVE-live-photo.jpg" }),
        ).toHaveCount(0);
        await page.reload();
        await expect(
          page.getByRole("textbox", { name: "Message", exact: true }),
        ).toBeVisible();
        pending = page
          .locator("article")
          .filter({ hasText: "LIVE-live-photo.jpg" });
        await expect(
          pending.locator('[data-outbox-state="failed"]'),
        ).toBeVisible();
        await pending.getByRole("button", { name: /^Retry / }).click();
      }
      const bubble = recipient
        .locator("article")
        .filter({ hasText: `LIVE-${file.name}` });
      await expect(bubble).toBeVisible({ timeout: 45000 });
      await expect(
        page
          .locator("article")
          .filter({ hasText: `LIVE-${file.name}` })
          .locator("[data-outbox-state]"),
      ).toHaveCount(0, { timeout: 45000 });
    }
    const history = await request.get(`${API}/messages/room/${room.id}`, {
      headers: auth(receiver.accessToken),
    });
    const rows = (await history.json()).data.messages;
    expect(rows).toHaveLength(4);
    const image = rows.find((row) => row.content === "LIVE-live-photo.jpg")
      .attachments[0];
    const original = await request.get(`${API}/attachments/${image.id}`, {
      headers: auth(receiver.accessToken),
    });
    expect(original.status()).toBe(200);
    expect((await original.body()).length).toBeGreaterThan(100);
    expect(
      (
        await request.get(`${API}/attachments/${image.id}`, {
          headers: auth(outsider.accessToken),
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.get(`${API}/attachments/${image.id}`, {
          headers: { ...auth(receiver.accessToken), range: "bytes=0-15" },
        })
      ).status(),
    ).toBe(206);
    const photoBubble = recipient
      .locator("article")
      .filter({ hasText: "LIVE-live-photo.jpg" });
    await photoBubble
      .getByRole("button", { name: "Open live-photo.jpg", exact: true })
      .click();
    const viewer = recipient.getByRole("dialog", {
      name: "live-photo.jpg",
      exact: true,
    });
    await expect(
      viewer.getByText("Downloaded · available offline", { exact: true }),
    ).toBeVisible();
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await receivedContext.setOffline(true);
    await photoBubble
      .getByRole("button", { name: "Open live-photo.jpg", exact: true })
      .click();
    await expect(
      viewer.getByRole("img", { name: "live-photo.jpg", exact: true }),
    ).toBeVisible();
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await receivedContext.setOffline(false);
    for (const row of rows) {
      const attachment = row.attachments[0];
      const response = await request.get(
        `${API}/attachments/${attachment.id}`,
        { headers: auth(receiver.accessToken) },
      );
      expect(response.status()).toBe(200);
      expect((await response.body()).length).toBeGreaterThan(0);
    }
    const videoBubble = recipient
      .locator("article")
      .filter({ hasText: "LIVE-live-video.webm" });
    await videoBubble
      .getByRole("button", { name: /^Download video live-video.webm/ })
      .click();
    await expect(videoBubble.locator("video")).toBeVisible();
    await expect
      .poll(() =>
        videoBubble.locator("video").evaluate((video) => video.readyState),
      )
      .toBeGreaterThanOrEqual(2);
    for (const name of ["live-audio.wav", "live-document.pdf"]) {
      const saved = recipient.waitForEvent("download", { timeout: 20000 });
      await recipient
        .getByRole("button", { name: `Download ${name}`, exact: true })
        .click();
      const download = await saved;
      expect(download.suggestedFilename()).toBe(name);
      expect(await download.failure()).toBeNull();
      expect(await download.path()).toBeTruthy();
    }
    const preview = await request.get(
      `${API}/attachments/${image.id}/preview-url`,
      { headers: auth(receiver.accessToken) },
    );
    expect(preview.status()).toBe(200);
    const signed = (await preview.json()).data.url;
    const workerResponse = await request.get(signed);
    const cors = workerResponse.headers()["access-control-allow-origin"];
    await info.attach("deployed-worker-probe", {
      body: JSON.stringify({
        status: workerResponse.status(),
        cors: cors || null,
        error: workerResponse.ok()
          ? null
          : (await workerResponse.text()).slice(0, 300),
      }),
      contentType: "application/json",
    });
    expect
      .soft(
        workerResponse.status(),
        "deployed Worker server-side preview; redeploy current Worker and verify IMAGES/MEDIA bindings",
      )
      .toBe(200);
    expect
      .soft(
        ["*", "http://localhost:5177"],
        "Worker must allow browser preview fetches",
      )
      .toContain(cors);
    if (
      workerResponse.ok() &&
      (cors === "*" || cors === "http://localhost:5177")
    ) {
      const worker = await recipient.evaluate(async (url) => {
        const response = await fetch(url);
        return {
          status: response.status,
          type: response.headers.get("content-type"),
          size: (await response.blob()).size,
        };
      }, signed);
      expect(worker.status).toBe(200);
      expect(worker.type).toContain("image/");
      expect(worker.size).toBeGreaterThan(0);
    } else {
      info.annotations.push({
        type: "deployment-required",
        description:
          "Worker preview rollout is incomplete: verify transformation bindings and deploy current source with CORS headers.",
      });
      await info.attach("worker-rollout-status", {
        body: JSON.stringify({
          serverPreview: workerResponse.status(),
          browserPreview: "pending Worker deployment and configuration",
        }),
        contentType: "application/json",
      });
    }
    const photoMessage = rows.find(
      (row) => row.content === "LIVE-live-photo.jpg",
    );
    expect(
      (
        await request.delete(`${API}/messages/${photoMessage.id}`, {
          headers: auth(sender.accessToken),
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.get(`${API}/attachments/${image.id}`, {
          headers: auth(receiver.accessToken),
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.get(`${API}/attachments/${image.id}/preview-url`, {
          headers: auth(receiver.accessToken),
        })
      ).status(),
    ).toBe(404);
    expect(
      await recipient.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await info.attach("core-media-checks", {
      body: JSON.stringify({
        viewport: info.project.name,
        uploads: "photo, video, audio, document",
        manualRetryAfterLost201: true,
        offlinePhotoCache: true,
        nativeVideoPlayback: true,
        savedFiles: true,
        privateRangeDownloads: true,
        deletedAccessDenied: true,
        responsive: true,
      }),
      contentType: "application/json",
    });
  } finally {
    await receivedContext.close();
  }
});
