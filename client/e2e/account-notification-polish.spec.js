import { test, expect } from "@playwright/test";

test("password visibility is reversible and never submits the login form", async ({ page }) => {
  await page.goto("/login");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("Example-passphrase-123");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).toHaveValue("Example-passphrase-123");
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(page).toHaveURL(/\/login$/);
});

test("signup requires matching confirmation and recovers after correcting it", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Display name", { exact: true }).fill("New member");
  await page.getByLabel("Email", { exact: true }).fill("member@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Example-passphrase-123");
  const confirmation = page.getByLabel("Confirm password", { exact: true });
  await confirmation.fill("Different-passphrase");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Passwords do not match.");
  await expect(confirmation).toBeFocused();
  await expect(page).toHaveURL(/\/register$/);
  await confirmation.fill("Example-passphrase-123");
  await page.getByRole("button", { name: "Show confirm password" }).click();
  await expect(confirmation).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/chats$/);
});

test("empty conversation text has an opaque surface in both themes", async ({ page }, info) => {
  await page.goto("/chats");
  const heading = page.getByRole("heading", { name: "Select a conversation" });
  if (info.project.name.includes("mobile")) {
    await expect(heading).toBeHidden();
    await expect(page.getByRole("heading", { name: "Chats", exact: true }).first()).toBeVisible();
    return;
  }
  const panel = heading.locator("..");
  for (const dark of [false, true]) {
    await page.evaluate(value => document.documentElement.classList.toggle("dark", value), dark);
    await expect(panel).toBeVisible();
    const color = await panel.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(color).not.toBe("rgba(0, 0, 0, 0)");
    expect(color).toMatch(/^rgb\(/);
  }
});

async function pushFixture(page, { failConfig = false, deniedStorage = false, permissionFailure = false } = {}) {
  await page.addInitScript(({ deniedStorage, permissionFailure }) => {
    window.__pushSetups = 0;
    window.__permissionPrompts = 0;
    Object.defineProperty(window, "Notification", { configurable: true, value: {
      permission: "default",
      requestPermission: async () => {
        window.__permissionPrompts++;
        if (permissionFailure) throw new Error("Permission unavailable");
        window.Notification.permission = "granted";
        return "granted";
      },
    } });
    if (deniedStorage) {
      for (const method of ["getItem", "setItem", "removeItem"]) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (key.startsWith("conclave.push-optout.")) throw new DOMException("Blocked", "SecurityError");
          return original.call(this, key, ...args);
        };
      }
    }
  }, { deniedStorage, permissionFailure });
  // Exercise the real provider and Settings UI; native push transport requires a
  // live provider/device. Mock only that boundary, not the setup state machine.
  await page.route("**/src/lib/pushNotifications.js*", route => route.fulfill({
    contentType: "application/javascript",
    body: `export const pushSupport=()=>true;
      export const clearBrowserPush=async()=>{};
      export const configureBrowserPush=async()=>{
        window.__pushSetups++;
        if (window.__holdSetup) {
          window.__holdSetup=false;
          return new Promise(resolve=>{window.__finishSetup=()=>resolve(false);});
        }
        return true;
      };`,
  }));
  await page.route("**/push/config", route => {
    return route.fulfill({
      status: failConfig ? 503 : 200,
      json: failConfig ? { message: "Temporary setup outage" } : { data: { configured: true, publicKey: "fixture" } },
    });
  });
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Notifications", exact: true }).click();
  return () => { failConfig = false; };
}

test("push enable recovers from an initial configuration outage", async ({ page }) => {
  const recover = await pushFixture(page, { failConfig: true });
  await expect(page.getByText("Temporary setup outage", { exact: true })).toBeVisible();
  recover();
  await page.getByRole("button", { name: "Enable in this browser" }).click();
  await expect(page.getByText("This browser is subscribed.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__pushSetups)).toBeGreaterThan(0);
});

test("restricted preference storage does not prevent notification setup", async ({ page }) => {
  await pushFixture(page, { deniedStorage: true });
  await page.getByRole("button", { name: "Enable in this browser" }).click();
  await expect(page.getByText("This browser is subscribed.", { exact: true })).toBeVisible();
});

test("permission failures give actionable feedback instead of an unhandled rejection", async ({ page }) => {
  await pushFixture(page, { permissionFailure: true });
  await page.getByRole("button", { name: "Enable in this browser" }).click();
  await expect(page.getByText("Could not enable notifications. Check this browser's permissions and retry.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry notification setup" })).toBeVisible();
});

test("enable is retried when another subscription check is in progress", async ({ page }) => {
  const recover = await pushFixture(page, { failConfig: true });
  await expect(page.getByText("Temporary setup outage", { exact: true })).toBeVisible();
  recover();
  await page.evaluate(() => {
    Notification.permission = "granted";
    window.__holdSetup = true;
    window.dispatchEvent(new Event("online"));
  });
  await expect.poll(() => page.evaluate(() => typeof window.__finishSetup)).toBe("function");
  await page.getByRole("button", { name: "Enable in this browser" }).click();
  await expect.poll(() => page.evaluate(() => window.__permissionPrompts)).toBe(1);
  await page.evaluate(() => window.__finishSetup());
  await expect(page.getByText("This browser is subscribed.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__pushSetups)).toBeGreaterThan(1);
});
