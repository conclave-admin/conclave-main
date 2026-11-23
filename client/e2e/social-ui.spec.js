import { test, expect } from "@playwright/test";
test("recorded mentions open a member profile and member rows use the same destination", async ({
  page,
}) => {
  await page.goto("/chats");
  await expect(
    page.locator('a[href="/chats/preview-room"]').first(),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { previewMessages } = await import("/src/config/devPreview.js");
    previewMessages.splice(0, previewMessages.length, {
      id: "profile-mention-message",
      room_id: "preview-room",
      sender_id: "dev-priya",
      sender_name: "Priya",
      content:
        "Hello @Victor, please review this. `@Victor` https://example.com/@Victor",
      mentioned_user_ids: ["dev-victor"],
      created_at: new Date().toISOString(),
      attachments: [],
      reactions: [],
      pins: { mine: [], room: null },
    });
  });
  await page.locator('a[href="/chats/preview-room"]').first().click();
  const message = page.locator('[data-message-id="profile-mention-message"]');
  const mention = message.getByRole("link", { name: "@Victor", exact: true });
  await expect(mention).toHaveCount(1);
  await expect(message.locator("code")).toHaveText("@Victor");
  await mention.click();
  await expect(page).toHaveURL(/\/profile\/dev-victor$/);
  await expect(
    page.getByRole("heading", { name: "Victor", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Product designer focused on clear, collaborative tools.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/conclave-member-profile-${test.info().project.name}.png`,
  });
  await page.goto("/chats/preview-room/info");
  await expect(
    page.getByRole("link", { name: "Victor", exact: true }),
  ).toHaveAttribute("href", "/profile/dev-victor");
  const memberName = page.getByRole("link", { name: "Victor", exact: true });
  expect(await memberName.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: `/tmp/conclave-room-info-overview-${test.info().project.name}.png` });
  await page
    .getByRole("link", { name: "Media and files", exact: true })
    .click();
  await expect(page.locator("#room-shared-media")).toBeFocused();
  await page.screenshot({
    path: `/tmp/conclave-room-info-${test.info().project.name}.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("desktop rail expands without covering content; mobile retains its menu", async ({
  page,
}, info) => {
  await page.mouse.move(600, 500);
  await page.goto("/chats");
  const rail = page.locator("aside.app-rail");
  if (info.project.name.includes("mobile")) {
    await expect(rail).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Open menu", exact: true }),
    ).toBeVisible();
    return;
  }
  await expect(
    page.getByRole("button", {
      name: /Open menu|Expand sidebar|Collapse sidebar/,
    }),
  ).toBeHidden();
  await page.getByRole("list", { name: "Conversations" }).waitFor();
  await page.mouse.move(800, 400);
  await expect(rail).toHaveCSS("width", "72px");
  await rail.hover();
  await expect(rail).toHaveCSS("width", "240px");
  const railRight = await rail.evaluate(
    (element) => element.getBoundingClientRect().right,
  );
  const contentLeft = await page
    .locator("#app-main-content")
    .evaluate((element) => element.getBoundingClientRect().left);
  expect(contentLeft).toBeGreaterThanOrEqual(railRight);
  await page.mouse.move(600, 500);
  await expect(rail).toHaveCSS("width", "72px");
  await rail.locator("a").first().focus();
  await expect(rail).toHaveCSS("width", "240px");
});

test("own profile retains editing controls without a duplicated preview card", async ({
  page,
}) => {
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "Your profile", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Change photo", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Amina Yusuf");
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete account", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
