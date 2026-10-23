import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
const API = "http://localhost:7120/api";
test.beforeEach(({}, info) => {
  test.skip(
    !info.project.name.startsWith("security-"),
    "requires the disposable real API in playwright.security.config.js",
  );
});
let accountNumber = 0;
async function account(request, name) {
  const result = await request.post(`${API}/auth/register`, {
    // Distinct simulated clients retain the real signup limiter without
    // exhausting a single localhost IP as the browser matrix grows.
    headers: { "X-Forwarded-For": `192.0.2.${++accountNumber}` },
    data: {
      email: `security-${name}-${Date.now()}@example.test`,
      displayName: `Security ${name}`,
      password: "Security browser password!",
    },
  });
  expect(result.status()).toBe(201);
  return (await result.json()).data;
}
async function login(page, session) {
  await page.goto("/login");
  await page.evaluate((s) => {
    localStorage.setItem("accessToken", s.accessToken);
    localStorage.setItem("refreshToken", s.refreshToken);
    localStorage.setItem("conclave.session-user", JSON.stringify(s.user));
  }, session);
  await page.goto("/settings");
  await expect(
    page.getByText("This device is ready for encrypted conversations.", {
      exact: true,
    }),
  ).toBeVisible();
}
test("real browsers encrypt text, offline drafts and files, receive privately and restore a key backup", async ({
  page,
  browser,
  request,
}, info) => {
  const sender = await account(request, `${info.project.name}-sender`),
    receiver = await account(request, `${info.project.name}-receiver`);
  const receiverContext = await browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: Boolean(info.project.use.isMobile),
    hasTouch: Boolean(info.project.use.hasTouch),
  });
  try {
    await login(page, sender);
    const recipient = await receiverContext.newPage();
    await login(recipient, receiver);
    const created = await request.post(`${API}/rooms`, {
      headers: { authorization: `Bearer ${sender.accessToken}` },
      data: { type: "dm", memberIds: [receiver.user.id] },
    });
    expect(created.status()).toBe(201);
    const room = (await created.json()).data;
    expect(room.encryption_mode).toBe("e2ee-v1");
    await recipient.goto(`/chats/${room.id}`);
    await recipient
      .getByRole("button", { name: "Accept request", exact: true })
      .click();
    await expect(
      recipient.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    await page.goto(`/chats/${room.id}`);
    const composer = page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await expect(composer).toBeVisible();
    const text = "E2EE-PRIVATE-TEXT ".repeat(180);
    await composer.fill(text);
    await composer.press("Enter");
    await expect(
      recipient.getByText(text.trim(), { exact: true }),
    ).toBeVisible();
    const stored = await request.get(`${API}/messages/room/${room.id}`, {
      headers: { authorization: `Bearer ${receiver.accessToken}` },
    });
    const rows = (await stored.json()).data.messages;
    expect(rows[0].content).toBe("[Encrypted message]");
    expect(rows[0].encrypted_payload).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain("E2EE-PRIVATE-TEXT");
    await recipient.reload();
    await expect(
      recipient.getByText(text.trim(), { exact: true }),
    ).toBeVisible();
    await page.context().setOffline(true);
    await composer.fill("E2EE-OFFLINE-QUEUED");
    await composer.press("Enter");
    await expect(
      page
        .locator("article")
        .filter({ hasText: "E2EE-OFFLINE-QUEUED" })
        .locator('[data-message-status="queued"]'),
    ).toBeVisible();
    await page.context().setOffline(false);
    await expect(
      recipient.getByText("E2EE-OFFLINE-QUEUED", { exact: true }),
    ).toBeVisible();
    const secret = Buffer.from("%PDF-1.4\nSECRET DOCUMENT CONTENT\n%%EOF");
    await page.locator('input[type="file"][multiple]').first().setInputFiles({
      name: "private-document.pdf",
      mimeType: "application/pdf",
      buffer: secret,
    });
    const editor = page.getByRole("dialog", {
      name: "Send attachment",
      exact: true,
    });
    await editor
      .getByPlaceholder("Add a caption…")
      .fill("E2EE-PRIVATE-CAPTION");
    await editor.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      recipient.getByText("E2EE-PRIVATE-CAPTION", { exact: true }),
    ).toBeVisible();
    const mediaRows = (
      await (
        await request.get(`${API}/messages/room/${room.id}`, {
          headers: { authorization: `Bearer ${sender.accessToken}` },
        })
      ).json()
    ).data.messages;
    const fileRow = mediaRows.find((row) => row.attachments?.length);
    expect(fileRow.attachments[0].filename).toBe("encrypted.bin");
    expect(fileRow.attachments[0].mime_type).toBe(
      "application/vnd.conclave.encrypted",
    );
    expect(JSON.stringify(mediaRows)).not.toContain("private-document.pdf");
    expect(JSON.stringify(mediaRows)).not.toContain("E2EE-PRIVATE-CAPTION");
    const downloadPromise = recipient.waitForEvent("download");
    await recipient
      .getByRole("button", {
        name: "Download private-document.pdf",
        exact: true,
      })
      .click();
    const download = await downloadPromise;
    expect(await fs.readFile(await download.path())).toEqual(secret);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await recipient.goto("/settings");
    await recipient
      .getByRole("button", {
        name: "Create or replace encrypted backup",
        exact: true,
      })
      .click();
    const key = await recipient
      .locator("code")
      .filter({ hasText: /^[A-Za-z0-9_-]{43}$/ })
      .textContent();
    expect(key).toHaveLength(43);
    await recipient
      .getByLabel("Encryption recovery key", { exact: true })
      .fill(key);
    await recipient
      .getByRole("button", { name: "Restore encrypted backup", exact: true })
      .click();
    await expect(
      recipient.getByText("Encryption keys restored to this device.", {
        exact: true,
      }),
    ).toBeVisible();
    await recipient.goto(`/chats/${room.id}`);
    await expect(
      recipient.getByText("E2EE-PRIVATE-CAPTION", { exact: true }),
    ).toBeVisible();
    await recipient.goto(`/chats/${room.id}/info`);
    await recipient
      .getByLabel("Search encrypted messages", { exact: true })
      .fill("E2EE-PRIVATE-CAPTION");
    await recipient
      .getByRole("button", { name: "Search", exact: true })
      .click();
    const searchResult = recipient.getByRole("link", {
      name: "E2EE-PRIVATE-CAPTION",
      exact: true,
    });
    await expect(searchResult).toBeVisible();
    const cleared = await request.post(`${API}/rooms/${room.id}/clear`, {
      headers: { authorization: `Bearer ${receiver.accessToken}` },
    });
    expect(cleared.status()).toBe(200);
    await expect(searchResult).toHaveCount(0);
    await composer.fill("Encrypted message after personal clear");
    await composer.press("Enter");
    await recipient.goto(`/chats/${room.id}`);
    await expect(
      recipient.getByText("Encrypted message after personal clear", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      recipient.getByText("E2EE-PRIVATE-CAPTION", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("E2EE-PRIVATE-CAPTION", { exact: true }),
    ).toBeVisible();
  } finally {
    await receiverContext.close();
  }
});

test("a lost first registration response preserves device keys and a second tab reuses the identity", async ({
  page,
  request,
  context,
}, info) => {
  const session = await account(
    request,
    `${info.project.name}-lost-registration`,
  );
  let lost = false;
  const registrations = [];
  await page.route("**/api/encryption/devices", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    registrations.push(route.request().postDataJSON());
    if (!lost) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      lost = true;
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.goto("/login");
  await page.evaluate((s) => {
    localStorage.setItem("accessToken", s.accessToken);
    localStorage.setItem("refreshToken", s.refreshToken);
    localStorage.setItem("conclave.session-user", JSON.stringify(s.user));
  }, session);
  await page.goto("/settings");
  await expect.poll(() => lost).toBe(true);
  await page
    .getByRole("button", { name: "Refresh encryption devices", exact: true })
    .click();
  await expect(
    page.getByText("This device is ready for encrypted conversations.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(registrations.length).toBeGreaterThan(1);
  expect(new Set(registrations.map((r) => r.identityKey)).size).toBe(1);
  expect(new Set(registrations.map((r) => r.id)).size).toBe(1);
  const peer = await context.newPage();
  await peer.goto("/settings");
  await expect(
    peer.getByText("This device is ready for encrypted conversations.", {
      exact: true,
    }),
  ).toBeVisible();
  const codes = await page.locator("code").allTextContents(),
    otherCodes = await peer.locator("code").allTextContents();
  expect(codes[0]).toBe(otherCodes[0]);
  expect(codes[1]).toBe(otherCodes[1]);
  await peer.close();
});

function voiceWave() {
  const samples = 16000,
    bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(
      Math.round(2000 * Math.sin((2 * Math.PI * 440 * i) / 8000)),
      44 + i * 2,
    );
  return bytes;
}
for (const encrypted of [false, true])
  test(`voice notes preview/discard and play cached ${encrypted ? "encrypted" : "server-readable"} audio offline`, async ({
    page,
    browser,
    request,
  }, info) => {
    const sender = await account(
      request,
      `${info.project.name}-voice-${encrypted}-sender`,
    );
    const receiver = await account(
      request,
      `${info.project.name}-voice-${encrypted}-receiver`,
    );
    const receiverContext = await browser.newContext({
      viewport: info.project.use.viewport,
      isMobile: Boolean(info.project.use.isMobile),
      hasTouch: Boolean(info.project.use.hasTouch),
    });
    try {
      await login(page, sender);
      const recipient = await receiverContext.newPage();
      await login(recipient, receiver);
      const created = await request.post(`${API}/rooms`, {
        headers: { authorization: `Bearer ${sender.accessToken}` },
        data: {
          type: encrypted ? "dm" : "group",
          name: "Voice notes",
          memberIds: [receiver.user.id],
        },
      });
      expect(created.status()).toBe(201);
      const room = (await created.json()).data;
      await recipient.goto(`/chats/${room.id}`);
      if (encrypted)
        await recipient
          .getByRole("button", { name: "Accept request", exact: true })
          .click();
      await page.goto(`/chats/${room.id}`);
      await page.context().grantPermissions(["microphone"]);
      await page
        .getByRole("button", { name: "Record voice note", exact: true })
        .click();
      const stop = page.getByRole("button", {
        name: "Stop voice note recording",
        exact: true,
      });
      await expect(stop).toBeVisible();
      // MediaRecorder needs real elapsed capture time to emit a decodable clip.
      await page.waitForTimeout(500);
      await stop.click();
      let editor = page.getByRole("dialog", {
        name: "Send attachment",
        exact: true,
      });
      await expect(editor.locator("audio")).toBeVisible();
      await editor
        .getByRole("button", { name: "Discard voice message" })
        .click();
      await expect(editor).toBeHidden();
      const empty = (
        await (
          await request.get(`${API}/messages/room/${room.id}`, {
            headers: { authorization: `Bearer ${sender.accessToken}` },
          })
        ).json()
      ).data;
      expect(empty.messages).toHaveLength(0);
      await page
        .getByRole("button", { name: "Record voice note", exact: true })
        .click();
      await expect(stop).toBeVisible();
      await page.waitForTimeout(500);
      await stop.click();
      editor = page.getByRole("dialog", {
        name: "Send attachment",
        exact: true,
      });
      await expect(editor.locator("audio")).toBeVisible();
      await editor.getByRole("button", { name: "Send", exact: true }).click();
      const recordedCard = recipient
        .getByRole("region", { name: "Voice message", exact: true })
        .first();
      await expect(recordedCard).toBeVisible();
      await recordedCard
        .getByRole("button", { name: /Download voice message/ })
        .click();
      const recordedAudio = recordedCard.locator("audio");
      await expect(recordedAudio).toBeVisible();
      await expect
        .poll(() =>
          recordedAudio.evaluate(
            (a) => Number.isFinite(a.duration) && a.duration > 0,
          ),
        )
        .toBe(true);
      await recordedAudio.evaluate((a) => a.play());
      await expect
        .poll(() => recordedAudio.evaluate((a) => a.currentTime))
        .toBeGreaterThan(0);
      await recordedAudio.evaluate((a) => a.pause());
      const wave = voiceWave();
      await page.locator('input[type="file"][multiple]').first().setInputFiles({
        name: "voice-sample.wav",
        mimeType: "audio/wav",
        buffer: wave,
      });
      editor = page.getByRole("dialog", {
        name: "Send attachment",
        exact: true,
      });
      await expect(editor.locator("audio")).toBeVisible();
      await editor.getByRole("button", { name: "Send", exact: true }).click();
      const card = recipient
        .getByRole("region", { name: "Voice message", exact: true })
        .last();
      await expect(card).toBeVisible();
      await card
        .getByRole("button", { name: /Download voice message/ })
        .click();
      const audio = card.locator("audio");
      await expect(audio).toBeVisible();
      await expect
        .poll(() => audio.evaluate((a) => a.readyState))
        .toBeGreaterThanOrEqual(1);
      await expect(
        card.getByText("Downloaded · available offline", { exact: true }),
      ).toBeVisible();
      await card
        .getByRole("combobox", { name: "Voice message playback speed" })
        .selectOption("1.5");
      expect(await audio.evaluate((a) => a.playbackRate)).toBe(1.5);
      await audio.evaluate((a) => {
        a.currentTime = 0.5;
      });
      expect(await audio.evaluate((a) => a.currentTime)).toBeGreaterThan(0.4);
      await receiverContext.setOffline(true);
      await audio.evaluate((a) => a.play());
      await expect
        .poll(() => audio.evaluate((a) => a.currentTime))
        .toBeGreaterThan(0.6);
      await audio.evaluate((a) => a.pause());
      expect(
        await recipient.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await receiverContext.setOffline(false);
      await recipient.reload();
      const reopened = recipient
        .getByRole("region", { name: "Voice message", exact: true })
        .last();
      await expect(reopened.locator("audio")).toBeVisible();
      await receiverContext.setOffline(true);
      await reopened.locator("audio").evaluate((a) => a.play());
      await expect
        .poll(() => reopened.locator("audio").evaluate((a) => a.currentTime))
        .toBeGreaterThan(0.1);
      const playing = await reopened.locator("audio").elementHandle();
      await recipient.evaluate(() =>
        window.dispatchEvent(new Event("conclave:outbox-stop")),
      );
      await expect.poll(() => playing.evaluate((a) => a.paused)).toBe(true);
      await expect(reopened.locator("audio")).toHaveCount(0);
      await playing.dispose();
    } finally {
      await receiverContext.close();
    }
  });

async function phase6SignIn(page, session, path) {
  await page.goto("/login");
  await page.evaluate((s) => {
    localStorage.setItem("accessToken", s.accessToken);
    localStorage.setItem("refreshToken", s.refreshToken);
    localStorage.setItem("conclave.session-user", JSON.stringify(s.user));
  }, session);
  await page.goto(path);
}
test("phase6: information, shared links, storage and account clearing synchronize without deleting peer history", async ({
  page,
  browser,
  request,
}, info) => {
  const a = await account(request, `${info.project.name}-phase6-info-a`),
    b = await account(request, `${info.project.name}-phase6-info-b`);
  const context = await browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: Boolean(info.project.use.isMobile),
    hasTouch: Boolean(info.project.use.hasTouch),
  });
  const second = await browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: Boolean(info.project.use.isMobile),
    hasTouch: Boolean(info.project.use.hasTouch),
  });
  try {
    await login(page, a);
    const peer = await context.newPage();
    await login(peer, b);
    const auth = { authorization: `Bearer ${a.accessToken}` },
      created = await request.post(`${API}/rooms`, {
        headers: auth,
        data: {
          type: "group",
          name: "Phase6 information",
          memberIds: [b.user.id],
        },
      });
    expect(created.status()).toBe(201);
    const id = (await created.json()).data.id;
    const sent = await request.post(`${API}/messages`, {
      headers: auth,
      data: {
        roomId: id,
        content: "Shared resource https://example.test/phase6",
      },
    });
    expect(sent.status()).toBe(201);
    const message = (await sent.json()).data;
    const upload = await request.post(`${API}/upload`, {
      headers: auth,
      multipart: {
        file: {
          name: "phase6.wav",
          mimeType: "audio/wav",
          buffer: voiceWave(),
        },
      },
    });
    expect(upload.status()).toBe(201);
    const media = await request.post(`${API}/messages`, {
      headers: auth,
      data: {
        roomId: id,
        attachments: [{ url: (await upload.json()).data.url }],
      },
    });
    expect(media.status()).toBe(201);
    await peer.goto(`/chats/${id}`);
    await expect(
      peer.getByText("Shared resource https://example.test/phase6", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await peer
        .getByRole("button", { name: "Message info", exact: true })
        .count(),
    ).toBe(0);
    const voice = peer.getByRole("region", {
      name: "Voice message",
      exact: true,
    });
    await voice.getByRole("button", { name: /Download voice message/ }).click();
    await expect(voice.locator("audio")).toBeVisible();
    await page.goto(`/chats/${id}`);
    await page
      .getByRole("button", { name: "Message info", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("dialog", { name: "Message information", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto(`/chats/${id}/info`);
    await peer.goto(`/chats/${id}/info`);
    const updatedName = `Updated participant ${info.project.name}`;
    const profile = await request.patch(`${API}/users/me`, {
      headers: { authorization: `Bearer ${b.accessToken}` },
      data: { display_name: updatedName },
    });
    expect(profile.status()).toBe(200);
    await expect(
      page.getByText(updatedName, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      peer.getByRole("heading", { name: "Shared links", exact: true }),
    ).toBeVisible();
    const mirror = await second.newPage();
    await phase6SignIn(mirror, b, `/chats/${id}/info`);
    await peer.getByLabel("Mute conversation", { exact: true }).check();
    await expect(
      mirror.getByLabel("Mute conversation", { exact: true }),
    ).toBeChecked();
    await expect(
      peer.getByText(/This account’s media cache on this device: 0.03 MB/),
    ).toBeVisible();
    await peer
      .getByRole("button", { name: "Remove downloaded copies", exact: true })
      .click();
    await peer
      .getByRole("button", { name: "Confirm cache removal", exact: true })
      .click();
    await expect(
      peer.getByText(/This account’s media cache on this device: 0.00 MB/),
    ).toBeVisible();
    await expect(
      peer.getByRole("link", {
        name: "https://example.test/phase6",
        exact: true,
      }),
    ).toBeVisible();
    await peer
      .getByRole("link", { name: "View source message", exact: true })
      .click();
    await expect(
      peer.locator(`[data-message-id="${message.id}"]`),
    ).toBeVisible();
    await peer.goto(`/chats/${id}/info`);
    await second.setOffline(true);
    await peer
      .getByRole("button", { name: "Clear for me on all devices", exact: true })
      .click();
    await peer
      .getByRole("button", { name: "Confirm clear for me", exact: true })
      .click();
    await expect(
      peer.getByRole("dialog", {
        name: "Clear your conversation history?",
        exact: true,
      }),
    ).toBeHidden();
    await expect(
      peer.getByRole("link", {
        name: "https://example.test/phase6",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      mirror.getByRole("link", {
        name: "https://example.test/phase6",
        exact: true,
      }),
    ).toBeVisible();
    await second.setOffline(false);
    await expect(
      mirror.getByRole("link", {
        name: "https://example.test/phase6",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", {
        name: "https://example.test/phase6",
        exact: true,
      }),
    ).toBeVisible();
    await peer.goto(`/chats/${id}`);
    await expect(
      peer.getByText("Shared resource https://example.test/phase6", {
        exact: true,
      }),
    ).toHaveCount(0);
    expect(
      await peer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close();
    await second.close();
  }
});
test("phase6: invitations, approval, live roles and handover enforce room permissions", async ({
  page,
  browser,
  request,
}, info) => {
  const a = await account(request, `${info.project.name}-phase6-admin`),
    b = await account(request, `${info.project.name}-phase6-member`),
    c = await account(request, `${info.project.name}-phase6-applicant`);
  const context = await browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: Boolean(info.project.use.isMobile),
    hasTouch: Boolean(info.project.use.hasTouch),
  });
  try {
    await login(page, a);
    const auth = { authorization: `Bearer ${a.accessToken}` },
      created = await request.post(`${API}/rooms`, {
        headers: auth,
        data: {
          type: "public",
          name: "Phase6 approvals",
          memberIds: [b.user.id],
        },
      });
    expect(created.status()).toBe(201);
    const id = (await created.json()).data.id;
    await page.goto(`/chats/${id}/info`);
    await page.getByLabel("Require approval to join", { exact: true }).check();
    await expect(
      page.getByText("Room permissions updated.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Create invitation link", exact: true })
      .click();
    const input = page.getByLabel(
      "Invitation link — copy and share privately",
      { exact: true },
    );
    await expect(input).toBeVisible();
    const url = await input.inputValue();
    const applicant = await context.newPage();
    await phase6SignIn(applicant, c, url);
    await applicant
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await expect(
      applicant.getByText("Your join request is pending admin approval.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (
        await request.get(`${API}/messages/room/${id}`, {
          headers: { authorization: `Bearer ${c.accessToken}` },
        })
      ).status(),
    ).toBe(403);
    await applicant.reload();
    await expect(
      applicant.getByRole("button", {
        name: "Check request status",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(c.user.display_name, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(
      page.getByText("Join request approved.", { exact: true }),
    ).toBeVisible();
    await applicant
      .getByRole("button", { name: "Check request status", exact: true })
      .click();
    await expect(applicant).toHaveURL(new RegExp(`/chats/${id}$`));
    await page
      .getByLabel("Allow participants to send messages", { exact: true })
      .uncheck();
    await expect(
      page.getByText("Room permissions updated.", { exact: true }),
    ).toBeVisible();
    await expect(
      applicant.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeDisabled();
    await expect(
      applicant.getByText("Only admins can send messages in this room.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Admin successor", exact: true })
      .selectOption(b.user.id);
    await page
      .getByRole("button", { name: "Review admin handover", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm handover", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Admin successor", exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await request.patch(`${API}/rooms/${id}/settings`, {
          headers: auth,
          data: { member_can_send: true },
        })
      ).status(),
    ).toBe(403);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});
