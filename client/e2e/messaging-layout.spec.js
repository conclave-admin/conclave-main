import { test, expect } from "@playwright/test";

async function inbox(page) {
  await page.goto("/chats");
  await expect(page.getByRole("list", { name: "Conversations" })).toBeVisible();
}
async function conversation(page) {
  await inbox(page);
  await page.locator('a[href="/chats/preview-room"]').first().click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
}

test("conversation rows remain full width and the rail does not obscure the list", async ({
  page,
}, info) => {
  await inbox(page);
  const row = page.locator(".chat-row").first();
  const list = page.getByRole("list", { name: "Conversations" });
  const [rowBox, listBox] = await Promise.all([
    row.boundingBox(),
    list.boundingBox(),
  ]);
  expect(Math.abs(rowBox.width - listBox.width)).toBeLessThanOrEqual(1);
  expect(rowBox.height).toBeLessThanOrEqual(76);
  if (!info.project.use.isMobile) {
    await page.locator(".app-rail").hover();
    await expect(page.locator(".app-rail")).toHaveCSS("width", "240px");
    const rail = await page.locator(".app-rail-panel").boundingBox();
    const expandedList = await list.boundingBox();
    expect(rail.x + rail.width).toBeLessThanOrEqual(expandedList.x + 1);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test("composer switches between voice and send and retains mention insertion", async ({
  page,
}) => {
  await conversation(page);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(
    page.getByRole("button", { name: "Record voice note", exact: true }),
  ).toBeVisible();
  await input.fill("A message ready to send");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Record voice note", exact: true }),
  ).toHaveCount(0);
  await input.fill("");
  await expect(
    page.getByRole("button", { name: "Record voice note", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await page.getByText("Mention someone", { exact: true }).click();
  await expect(input).toHaveValue("@");
  await expect(input).toBeFocused();
});

test("typing indicator stays by the composer while focused history scroll reaches both ends", async ({
  page,
}, info) => {
  test.skip(!info.project.name.startsWith("app-"), "uses the app preview");
  await page.goto("/chats/preview-large-room");
  const scroller = page.locator("[data-message-scroll]");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(page.locator('[data-message-id="perf-1199"]')).toBeVisible({
    timeout: 25000,
  });
  await input.fill("I am typing while reviewing the conversation");
  const indicator = page.locator(".typing-indicator");
  await expect(indicator).toBeVisible();
  await expect(input).toBeFocused();
  await expect(page.locator(".composer-pill")).toHaveCSS("border-width", "0px");

  const expectIndicatorAboveComposer = async () => {
    const indicatorBox = await indicator.boundingBox();
    const composerBox = await page.locator(".composer-pill").boundingBox();
    expect(indicatorBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(indicatorBox.y + indicatorBox.height).toBeLessThanOrEqual(
      composerBox.y + 1,
    );
    expect(composerBox.y - (indicatorBox.y + indicatorBox.height)).toBeLessThan(
      56,
    );
  };

  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator('[data-message-id="perf-0"]')).toBeVisible();
  await expect(input).toBeFocused();
  await expectIndicatorAboveComposer();

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() =>
    scroller.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    ),
  ).toBeLessThanOrEqual(2);
  await expect(page.locator('[data-message-id="perf-1199"]')).toBeVisible();
  await expect(input).toBeFocused();
  await expectIndicatorAboveComposer();
});

test("text bubbles retain their own timestamps and receipt details within a grouped run", async ({
  page,
}) => {
  await inbox(page);
  await page.evaluate(async () => {
    const { previewMessages, previewUser } = await import(
      "/src/config/devPreview.js"
    );
    previewMessages.splice(
      0,
      previewMessages.length,
      ...[0, 1].map((index) => ({
        id: `layout-message-${index}`,
        room_id: "preview-room",
        sender_id: previewUser.id,
        sender_name: previewUser.display_name,
        content: `Grouped layout message ${index}`,
        created_at: new Date(Date.now() + index * 1000).toISOString(),
        reactions: [],
        attachments: [],
        pins: { mine: [], room: null },
        receipt_summary: {
          history_complete: true,
          recipient_count: 1,
          delivered_count: 1,
          read_count: 1,
        },
      })),
    );
  });
  await page.locator('a[href="/chats/preview-room"]').first().click();
  for (let index = 0; index < 2; index++) {
    const message = page.locator(`[data-message-id="layout-message-${index}"]`);
    await expect(message.locator(".message-bubble time")).toHaveCount(1);
    await expect(
      message.locator('.message-bubble [data-message-status="read"]'),
    ).toBeVisible();
    await expect(
      message.getByRole("button", { name: "Message info", exact: true }),
    ).toBeVisible();
  }
});

test("settings shortcuts preserve keyboard focus and dark-theme mobile layout", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await expect(page.locator("#settings-media")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Clear downloaded media", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});
