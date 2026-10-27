import { test, expect } from "@playwright/test";

test("task board shows progress controls only to the assignee", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByText("Turn conversations into progress.")).toBeVisible();
  await page.getByRole("button", { name: /Draft API rate-limit docs/ }).click();
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await expect(page.getByText("Move progress")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /Confirm production upload limits/ }).click();
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await expect(page.getByText("Move progress")).toHaveCount(0);
});

test("a new task can be created from the board", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByRole("textbox", { name: "Task", exact: true }).fill("Prepare launch checklist");
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prepare launch checklist" })).toBeVisible();
});
