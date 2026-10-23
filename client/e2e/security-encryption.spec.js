import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
const API = "http://localhost:7120/api";
test.beforeEach(({}, info) => {
  test.skip(
    !info.project.name.startsWith("security-"),
    "requires the disposable real API in playwright.security.config.js",
  );
});
async function account(request, name) {
  const result = await request.post(`${API}/auth/register`, {
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
    await page
      .locator('input[type="file"][multiple]')
      .first()
      .setInputFiles({
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
