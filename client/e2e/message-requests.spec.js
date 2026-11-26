import { expect, test } from "@playwright/test";

test.describe("message request safety flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/message-requests");
    await expect(page.getByRole("heading", { name: "Message requests" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Victor" })).toBeVisible();
  });

  test("message requests can be opened from the chat list", async ({ page }) => {
    await page.goto("/chats");
    await page.getByRole("link", { name: "Message requests" }).click();
    await expect(page).toHaveURL(/\/message-requests$/);
    await expect(page.getByRole("heading", { name: "Victor" })).toBeVisible();
  });

  test("decline offers a short undo and remains accept-able after the undo window", async ({ page }) => {
    await page.getByRole("button", { name: "Decline" }).click();
    await expect(page.getByText("Declined", { exact: true })).toBeVisible();
    const undo = page.getByRole("button", { name: /Undo decline/ });
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(page.getByText("New request", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Decline" }).click();
    await page.waitForTimeout(10_200);
    await expect(page.getByRole("button", { name: /Undo decline/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page).toHaveURL(/\/chats\/preview-dm$/);
  });

  test("recipient can report or block a requester", async ({ page }) => {
    await page.getByRole("button", { name: "Report" }).click();
    await page.getByLabel("Reason").selectOption("harassment");
    await page.getByLabel("Details (optional)").fill("Unwanted repeated contact");
    await page.getByRole("button", { name: "Submit report" }).click();
    await expect(page.getByText("The request is still available to accept or decline.")).toBeVisible();

    await page.getByRole("button", { name: "Block", exact: true }).click();
    await page.getByRole("button", { name: "Block person" }).click();
    await expect(page.getByRole("heading", { name: "No message requests" })).toBeVisible();
  });
});
