import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
const API = "http://localhost:7120/api";
test.beforeEach(({}, info) => {
  test.skip(
    !info.project.name.startsWith("security-"),
    "requires the disposable real API in playwright.security.config.js",
  );
});
async function account(request, name) {
  const nonce = randomBytes(6).toString("hex");
  const address = [...randomBytes(3)].map(value => value || 1).join(".");
  const result = await request.post(`${API}/auth/register`, {
    // Distinct simulated clients retain the real signup limiter without
    // exhausting a single localhost IP as the browser matrix grows.
    headers: { "X-Forwarded-For": `10.${address}` },
    data: {
      email: `security-${name}-${nonce}@example.test`,
      displayName: `Security ${name} ${nonce}`,
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
  await page.goto("/chats");
  // Navigation completion precedes React's authenticated shell being ready.
  await expect(page.getByRole("main")).toBeVisible();
}
// Record progress in the browser: short clips reset currentTime on ended,
// which can happen between runner polls on a busy machine. Install a fresh
// observer for each playback so offline checks cannot reuse earlier progress.
async function expectPlaybackProgress(audio, seconds) {
  await audio.evaluate(async (element) => {
    element.__testPlaybackMax = 0;
    element.__testPlaybackObserver = () => {
      if (element.played.length)
        element.__testPlaybackMax = Math.max(
          element.__testPlaybackMax,
          element.currentTime,
        );
    };
    element.addEventListener("timeupdate", element.__testPlaybackObserver);
    await element.play();
  });
  try {
    await expect
      .poll(() => audio.evaluate((element) => element.__testPlaybackMax))
      .toBeGreaterThan(seconds);
  } finally {
    await audio.evaluate((element) => {
      element.removeEventListener("timeupdate", element.__testPlaybackObserver);
      delete element.__testPlaybackObserver;
      delete element.__testPlaybackMax;
    });
  }
}

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
test(`voice notes preview/discard and play cached audio offline`, async ({
  page,
  browser,
  request,
}, info) => {
  const sender = await account(request, `${info.project.name}-voice-sender`);
  const receiver = await account(
    request,
    `${info.project.name}-voice-receiver`,
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
        type: "group",
        name: "Voice notes",
        memberIds: [receiver.user.id],
      },
    });
    expect(created.status()).toBe(201);
    const room = (await created.json()).data;
    await recipient.goto(`/chats/${room.id}`);
    await page.goto(`/chats/${room.id}`);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    await expect(
      recipient.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
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
    await expect(editor.locator("audio")).toBeAttached();
    await expect(
      editor.getByRole("button", { name: "Play Voice message", exact: true }),
    ).toBeVisible();
    await editor.getByRole("button", { name: "Discard voice message" }).click();
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
    await expect(editor.locator("audio")).toBeAttached();
    await expect(
      editor.getByRole("button", { name: "Play Voice message", exact: true }),
    ).toBeVisible();
    await editor.getByRole("button", { name: "Send", exact: true }).click();
    const recordedCard = recipient
      .getByRole("region", { name: "Voice message", exact: true })
      .first();
    await expect(recordedCard).toBeVisible();
    await recordedCard
      .getByRole("button", { name: "Play Voice message" })
      .click();
    const recordedAudio = recordedCard.locator("audio");
    await expect(recordedAudio).toBeAttached();
    await expect
      .poll(() =>
        recordedAudio.evaluate(
          (a) => Number.isFinite(a.duration) && a.duration > 0,
        ),
      )
      .toBe(true);
    await expectPlaybackProgress(recordedAudio, 0);
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
    await expect(editor.locator("audio")).toBeAttached();
    await expect(
      editor.getByRole("button", { name: "Play Voice message", exact: true }),
    ).toBeVisible();
    await editor.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      recipient.getByRole("region", { name: "Voice message", exact: true }),
    ).toHaveCount(2);
    const card = recipient
      .getByRole("region", { name: "Voice message", exact: true })
      .last();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Play Voice message" }).click();
    const audio = card.locator("audio");
    await expect(audio).toBeAttached();
    await expect
      .poll(() => audio.evaluate((a) => a.readyState))
      .toBeGreaterThanOrEqual(1);
    await expect(card).toHaveAttribute("data-media-offline", "true");
    await card
      .getByRole("button", { name: "Playback speed 1 times. Change speed" })
      .click();
    await expect.poll(() => audio.evaluate((a) => a.playbackRate)).toBe(1.5);
    await audio.evaluate((a) => {
      a.currentTime = 0.5;
    });
    expect(await audio.evaluate((a) => a.currentTime)).toBeGreaterThan(0.4);
    await receiverContext.setOffline(true);
    await expectPlaybackProgress(audio, 0.6);
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
    await expect(reopened.locator("audio")).toBeAttached();
    await receiverContext.setOffline(true);
    await expect
      .poll(() => reopened.locator("audio").evaluate((a) => a.readyState))
      .toBeGreaterThanOrEqual(2);
    await expectPlaybackProgress(reopened.locator("audio"), 0.1);
    const playing = await reopened.locator("audio").elementHandle();
    await recipient.evaluate(() =>
      window.dispatchEvent(new Event("conclave:outbox-stop")),
    );
    await expect.poll(() => playing.evaluate((a) => a.paused)).toBe(true);
    await expect(reopened.locator("audio")).not.toHaveAttribute("src");
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
          name: "voice-phase6.wav",
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
    await voice.getByRole("button", { name: "Play Voice message" }).click();
    await expect(voice.locator("audio")).toBeAttached();
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
      peer.getByText("Downloaded on this device: 0.03 MB", { exact: true }),
    ).toBeVisible();
    await peer
      .getByRole("button", { name: "Remove downloaded copies", exact: true })
      .click();
    await peer
      .getByRole("button", { name: "Confirm cache removal", exact: true })
      .click();
    await expect(
      peer.getByText("Downloaded on this device: 0.00 MB", { exact: true }),
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

test("ux: drafts, rich long messages, local navigation, search, focus and emoji picker work together", async ({
  page,
  request,
}, info) => {
  const a = await account(request, `${info.project.name}-ux`);
  await login(page, a);
  const headers = { authorization: `Bearer ${a.accessToken}` };
  const created = await request.post(`${API}/rooms`, {
    headers,
    data: { type: "group", name: "Experience checks" },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id;
  const body =
    "**Important update**\n" +
    "Long readable text. ".repeat(110) +
    '\n```js\nconst safe = "<script>";\n```\nhttps://example.test/resource';
  const sent = await request.post(`${API}/messages`, {
    headers,
    data: { roomId: id, content: body },
  });
  expect(sent.status()).toBe(201);
  const message = (await sent.json()).data;
  await page.goto(`/chats/${id}`);
  const article = page.locator(`[data-message-id="${message.id}"]`);
  await article.getByRole("button", { name: "Read more", exact: true }).click();
  await expect(
    article.locator("strong").filter({ hasText: "Important update" }),
  ).toBeVisible();
  await expect(article.locator("pre code")).toContainText("const safe");
  await expect(
    article.getByRole("link", {
      name: "https://example.test/resource",
      exact: true,
    }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  await article.getByRole("button", { name: "Show less", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Durable unsent draft");
  await page.goto("/profile");
  await page.goto(`/chats/${id}`);
  await expect(composer).toHaveValue("Durable unsent draft");
  await page
    .getByRole("button", { name: "Search conversation", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Search conversation",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search messages", { exact: true }).fill("Important");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  const result = dialog
    .getByRole("button")
    .filter({ hasText: "Important update" });
  await expect(result).toBeVisible();
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      Boolean(document.activeElement.closest('[role="dialog"]')),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.querySelector("#root")?.inert),
  ).toBe(true);
  await result.click();
  await expect(page).toHaveURL(new RegExp(`message=${message.id}`));
  await expect(
    page.locator(`[data-message-id="${message.id}"] pre code`),
  ).toBeVisible();
  await composer.fill("");
  await page.locator(`[data-message-id="${message.id}"]`).hover();
  if (info.project.name.includes("mobile"))
    await page
      .locator(`[data-message-id="${message.id}"]`)
      .getByText("Important update", { exact: true })
      .dispatchEvent("contextmenu");
  else
    await page
      .locator(`[data-message-id="${message.id}"]`)
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  const menu = page.getByRole("menu", { name: "Message actions", exact: true });
  await menu.locator('em-emoji-picker input[type="search"]').fill("rocket");
  await menu.locator('em-emoji-picker button[aria-label="🚀"]').click();
  await expect(
    page.getByRole("button", { name: "🚀 reaction, 1", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("ux: thread panel, saved notes, notification preferences and scheduled text are reachable", async ({
  page,
  request,
}, info) => {
  const a = await account(request, `${info.project.name}-ux-tools`);
  await login(page, a);
  const headers = { authorization: `Bearer ${a.accessToken}` };
  const created = await request.post(`${API}/rooms`, {
    headers,
    data: { type: "group", name: "Thread and tools" },
  });
  const id = (await created.json()).data.id;
  const root = (
    await (
      await request.post(`${API}/messages`, {
        headers,
        data: { roomId: id, content: "A persistent thread topic" },
      })
    ).json()
  ).data;
  await request.post(`${API}/messages`, {
    headers,
    data: {
      roomId: id,
      threadRootId: root.id,
      replyToId: root.id,
      content: "Thread history outside the loaded page",
    },
  });
  await page.goto(`/chats/${id}?message=${root.id}&thread=${root.id}`);
  const panel = page.getByRole("complementary", {
    name: "Message thread",
    exact: true,
  });
  await expect(
    panel.getByText("Thread history outside the loaded page", { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Reply through persistent thread");
  await panel
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    panel.getByText("Reply through persistent thread", { exact: true }),
  ).toBeVisible();
  await panel
    .locator('input[type="file"][multiple]')
    .first()
    .setInputFiles({
      name: "thread-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("A document in a persistent thread"),
    });
  const mediaEditor = page.getByRole("dialog", {
    name: "Send attachment",
    exact: true,
  });
  await mediaEditor.getByRole("button", { name: "Send", exact: true }).click();
  await expect(mediaEditor).toBeHidden();
  await expect(
    panel.getByText("thread-note.txt", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await request.get(
        `${API}/experience/threads/${root.id}`,
        { headers },
      );
      return (await response.json()).data.messages.some((m) =>
        m.attachments?.some((a) => a.filename === "thread-note.txt"),
      );
    })
    .toBe(true);
  await panel
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  await page.goto(`/chats/${id}/info`);
  await page.getByLabel("Notify me", { exact: true }).selectOption("mentions");
  await page.getByLabel("Mute duration", { exact: true }).selectOption("hour");
  await page
    .getByRole("button", { name: "Save notifications", exact: true })
    .click();
  await expect
    .poll(async () => {
      const res = await request.get(`${API}/experience/rooms/${id}/settings`, {
        headers,
      });
      return (await res.json()).data.notification_level;
    })
    .toBe("mentions");
  await page.goto(`/chats/${id}`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Schedule from the composer");
  await page
    .getByRole("button", { name: "Schedule text", exact: true })
    .click();
  const schedule = page.getByRole("dialog", {
    name: "Schedule this text message",
    exact: true,
  });
  const date = new Date(Date.now() + 3600000);
  const local = new Date(+date - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await schedule.getByLabel("Send date and time", { exact: true }).fill(local);
  await schedule
    .getByRole("button", { name: "Confirm schedule", exact: true })
    .click();
  await expect(schedule).toBeHidden();
  await page.goto("/activity?tab=schedules");
  await expect(
    page.getByText("Waiting to send", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .first()
    .click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await page.goto("/activity?tab=saved");
  await page
    .getByRole("button", { name: "Open private notes", exact: true })
    .click();
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
});

test("ux: reading position survives navigation and deleting a chat uses a focused personal confirmation", async ({
  page,
  request,
}, info) => {
  const a = await account(request, `${info.project.name}-ux-reading`),
    b = await account(request, `${info.project.name}-ux-peer`);
  await login(page, a);
  const headers = { authorization: `Bearer ${a.accessToken}` };
  const room = (
    await (
      await request.post(`${API}/rooms`, {
        headers,
        data: {
          type: "group",
          name: "Reading position",
          memberIds: [b.user.id],
        },
      })
    ).json()
  ).data;
  const ids = [];
  for (let i = 0; i < 16; i++) {
    const result = await request.post(`${API}/messages`, {
      headers,
      data: {
        roomId: room.id,
        content:
          `Reading message ${i}\n` + "Useful conversation context. ".repeat(15),
      },
    });
    expect(result.status()).toBe(201);
    ids.push((await result.json()).data.id);
  }
  await page.goto(`/chats/${room.id}`);
  await expect(page.locator(`[data-message-id="${ids[8]}"]`)).toBeAttached();
  await page.locator("[data-message-scroll]").evaluate((container, id) => {
    const node = container.querySelector(`[data-message-id="${id}"]`);
    container.scrollTop +=
      node.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      18;
    container.dispatchEvent(new Event("scroll"));
  }, ids[8]);
  const storageKey = `conclave:reading:${a.user.id}:${room.id}`;
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) || "null")?.atBottom,
        storageKey,
      ),
    )
    .toBe(false);
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
  await page.goto("/profile");
  await page.goto(`/chats/${room.id}`);
  const target = page.locator(`[data-message-id="${saved.id}"]`);
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate(
        (node, offset) =>
          Math.abs(
            node.getBoundingClientRect().top -
              node.closest("[data-message-scroll]").getBoundingClientRect()
                .top -
              offset,
          ),
        saved.offset,
      ),
    )
    .toBeLessThan(10);
  await page.goto("/chats");
  await page
    .getByRole("button", { name: "Actions for Reading position", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete chat", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete this chat?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("#root").inert)).toBe(
    true,
  );
  await dialog.getByRole("button", { name: "Keep chat", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => document.querySelector("#root").inert)).toBe(
    false,
  );
  await page
    .getByRole("button", { name: "Actions for Reading position", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete chat", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Delete chat for me", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const peer = (
    await (
      await request.get(`${API}/messages/room/${room.id}`, {
        headers: { authorization: `Bearer ${b.accessToken}` },
      })
    ).json()
  ).data;
  expect(peer.messages).toHaveLength(16);
});
