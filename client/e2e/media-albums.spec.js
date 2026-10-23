import { test, expect } from "@playwright/test";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
async function setup(page) {
  await page.route("**/attachments/album-file-*", (route) =>
    route.fulfill({ contentType: "image/png", body: png }),
  );
  await page.goto("/chats");
  await expect(
    page.locator('a[href="/chats/preview-room"]').first(),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { previewMessages } = await import("/src/config/devPreview.js");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    canvas.getContext("2d").fillRect(0, 0, 160, 90);
    const preview = canvas.toDataURL("image/jpeg", 0.5);
    previewMessages.splice(
      0,
      previewMessages.length,
      ...[0, 1, 2].map((index) => ({
        id: `album-message-${index}`,
        album_id: "album-test",
        room_id: "preview-room",
        sender_id: "peer",
        sender_name: "Album Sender",
        content: `ALBUM-CAPTION-${index} ${index === 1 ? "A long caption stays readable on a narrow screen. ".repeat(20) : ""}`,
        created_at: new Date(Date.now() + index).toISOString(),
        reactions: [],
        pins: { mine: [], room: null },
        attachments: [
          {
            id: `album-file-${index}`,
            url: `r2://private/album-${index}`,
            filename: `album-${index}.png`,
            size: 70,
            mime_type: "image/png",
            width: 160,
            height: 90,
            preview_url: preview,
          },
        ],
      })),
    );
  });
  await page.locator('a[href="/chats/preview-room"]').first().click();
}
test.beforeEach(async ({}, info) =>
  test.skip(!info.project.name.startsWith("app-"), "uses signed-in fixture"),
);

test("album grid preserves captions and opens a zoomable, navigable viewer with message jump", async ({
  page,
}) => {
  await setup(page);
  const album = page.locator('[data-album-id="album-test"]');
  await expect(album.locator("article")).toHaveCount(3);
  await expect(album).toHaveCSS("display", "grid");
  await expect(
    album.locator('[data-message-id="album-message-1"]'),
  ).toContainText("ALBUM-CAPTION-1");
  await album
    .getByRole("button", { name: "Open album-0.png", exact: true })
    .click();
  let viewer = page.getByRole("dialog", { name: "album-0.png", exact: true });
  await expect(viewer.getByText("1 of 3", { exact: true })).toBeVisible();
  await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(viewer.getByText("150%", { exact: true })).toBeVisible();
  await viewer.getByRole("button", { name: "Reset zoom", exact: true }).click();
  await viewer.getByRole("button", { name: "Next media", exact: true }).click();
  viewer = page.getByRole("dialog", { name: "album-1.png", exact: true });
  await expect(viewer.getByText("2 of 3", { exact: true })).toBeVisible();
  await viewer.focus();
  await page.keyboard.press("ArrowRight");
  viewer = page.getByRole("dialog", { name: "album-2.png", exact: true });
  await expect(viewer.getByText("3 of 3", { exact: true })).toBeVisible();
  await viewer
    .getByRole("button", { name: "Show message", exact: true })
    .click();
  await expect(viewer).not.toBeVisible();
  await expect(page.locator('[data-message-id="album-message-2"]')).toHaveClass(
    /message-jump-highlight/,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test("album swipe changes the selected file while each message retains its own reply action", async ({
  page,
}, info) => {
  await setup(page);
  const target = page.locator('[data-message-id="album-message-1"]');
  if (info.project.name === "app-mobile")
    await target.locator("img").dispatchEvent("contextmenu", { bubbles: true });
  else {
    await target.hover();
    await target
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  }
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(
    page.locator("form").getByText("Replying to Album Sender", { exact: true }),
  ).toBeVisible();
  await page
    .locator('[data-message-id="album-message-0"]')
    .getByRole("button", { name: "Open album-0.png", exact: true })
    .click();
  const surface = page.getByTestId("media-viewer-surface");
  await surface.dispatchEvent("pointerdown", {
    pointerId: 1,
    clientX: 250,
    clientY: 150,
    pointerType: "touch",
    bubbles: true,
  });
  await surface.dispatchEvent("pointerup", {
    pointerId: 1,
    clientX: 100,
    clientY: 155,
    pointerType: "touch",
    bubbles: true,
  });
  await expect(
    page.getByRole("dialog", { name: "album-1.png", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator("form").getByText("Replying to Album Sender", { exact: true }),
  ).toBeVisible();
});

test("direct multipart upload resumes a completed part after failure and reload", async ({
  page,
}) => {
  const id = "10000000-0000-4000-8000-000000000099";
  const partSize = 8 * 1024 * 1024;
  let put1 = 0;
  let put2 = 0;
  let firstSaved = false;
  let fail = true;
  let completed = 0;
  await page.route("**/upload/capabilities", (route) =>
    route.fulfill({ json: { success: true, data: { multipart: true } } }),
  );
  const session = () => ({
    id,
    partSize,
    parts: firstSaved ? [{ partNumber: 1, size: partSize, etag: '"one"' }] : [],
  });
  await page.route("**/upload/sessions", (route) =>
    route.fulfill({ status: 201, json: { success: true, data: session() } }),
  );
  await page.route(`**/upload/sessions/${id}`, (route) =>
    route.fulfill({ json: { success: true, data: session() } }),
  );
  await page.route(`**/upload/sessions/${id}/parts`, (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          url: `https://private-r2.example.test/part-${route.request().postDataJSON().partNumber}`,
        },
      },
    }),
  );
  await page.route("https://private-r2.example.test/**", (route) => {
    const first = route.request().url().endsWith("part-1");
    if (first) {
      put1++;
      firstSaved = true;
    } else put2++;
    if (!first && fail)
      return route.fulfill({
        status: 503,
        body: "Unavailable",
        headers: { "access-control-allow-origin": "*" },
      });
    return route.fulfill({
      status: 200,
      headers: {
        etag: first ? '"one"' : '"two"',
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "ETag",
      },
    });
  });
  await page.route(`**/upload/sessions/${id}/complete`, (route) => {
    completed++;
    return route.fulfill({
      json: {
        success: true,
        data: {
          url: "r2://private/resumed.pdf",
          filename: "resumed.pdf",
          mime_type: "application/pdf",
          size: partSize + 32,
        },
      },
    });
  });
  await page.goto("/chats/preview-room");
  await page
    .locator('input[type="file"][multiple]')
    .first()
    .setInputFiles({
      name: "resumed.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.alloc(partSize + 32, 32),
    });
  const editor = page.getByRole("dialog", {
    name: "Send attachment",
    exact: true,
  });
  await editor.getByPlaceholder("Add a caption…").fill("DIRECT-RESUME-CAPTION");
  await editor.getByRole("button", { name: "Send", exact: true }).click();
  let message = page
    .locator("article")
    .filter({ hasText: "DIRECT-RESUME-CAPTION" });
  await expect(message.locator('[data-outbox-state="failed"]')).toBeVisible();
  expect(put1).toBe(1);
  expect(put2).toBe(1);
  expect(completed).toBe(0);
  fail = false;
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  message = page
    .locator("article")
    .filter({ hasText: "DIRECT-RESUME-CAPTION" });
  await expect(message.locator('[data-outbox-state="failed"]')).toBeVisible();
  await message.getByRole("button", { name: /^Retry / }).click();
  await expect.poll(() => completed).toBe(1);
  await expect(message.locator("[data-outbox-state]")).toHaveCount(0);
  expect(put1).toBe(1);
  expect(put2).toBe(2);
});
