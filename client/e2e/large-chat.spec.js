import { test, expect } from "@playwright/test";

test("large history mounts a bounded window and locates an earlier reply", async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("app-"), "uses the app preview");
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__blobURLs = { created: 0, active: new Set() };
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.__blobURLs.created += 1;
      window.__blobURLs.active.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.__blobURLs.active.delete(url);
      return revoke(url);
    };
  });
  await page.goto("/chats/preview-large-room");
  await expect(page.locator("[data-message-id]").first()).toBeVisible({ timeout: 25000 });
  const latest = page.locator('[data-message-id="perf-1199"]');
  if (!(await latest.isVisible()))
    await page.getByRole("button", { name: /Jump to latest|new messages/ }).click();
  await expect(latest).toBeVisible();
  const mounted = await page.locator("[data-message-id]").count();
  expect(mounted).toBeLessThan(80);
  const horizontalOverflow = () => page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
  await testInfo.attach("large-chat-metrics.json", {
    body: JSON.stringify(await page.evaluate(() => ({
      fixtureMessages: 1200,
      mountedRows: document.querySelectorAll("[data-message-id]").length,
      scrollHeight: document.querySelector("[data-message-scroll]")?.scrollHeight,
      usedJsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
    }))),
    contentType: "application/json",
  });

  await latest.getByRole("button", { name: /Replying to/ }).click();
  const target = page.locator('[data-message-id="perf-300"]');
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/message-jump-highlight/);
  expect(await page.locator("[data-message-id]").count()).toBeLessThan(80);
  await expect.poll(() => page.evaluate(() => window.__blobURLs.created)).toBeGreaterThan(0);
  await page.getByRole("button", { name: /Jump to latest|new messages/ }).click();
  await expect(latest).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__blobURLs.active.size)).toBe(0);
  await page.getByRole("button", { name: /Pinned message/ }).click();
  await page
    .locator("#pinned-messages-list")
    .getByRole("button", { name: /Earlier target in a large conversation/ })
    .click();
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/message-jump-highlight/);
  const savedId = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("conclave:reading:dev-preview-user:preview-large-room"))?.id,
  );
  expect(savedId).toMatch(/^perf-(29\d|30\d)$/);
  await page.reload();
  await expect(page.locator(`[data-message-id="${savedId}"]`)).toBeVisible({ timeout: 25000 });

  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
});

test("manual full-render versus windowed baseline", async ({ page }, testInfo) => {
  test.skip(
    process.env.CONCLAVE_PERF_BASELINE !== "1" ||
      testInfo.project.name !== "app-desktop",
    "Run explicitly with CONCLAVE_PERF_BASELINE=1 on the desktop project",
  );
  test.setTimeout(120000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const sample = async (path, expectedRows) => {
    const started = Date.now();
    await page.goto(path);
    await expect.poll(
      () => page.locator("[data-message-id]").count(),
      { timeout: 60000 },
    ).toBeGreaterThan(expectedRows);
    const loadToRowsMs = Date.now() - started;
    const metrics = await page.evaluate(async () => {
      const scroller = document.querySelector("[data-message-scroll]");
      const begin = performance.now();
      for (let step = 0; step < 20; step += 1) {
        scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * step / 19;
        await new Promise(requestAnimationFrame);
      }
      return {
        mountedRows: document.querySelectorAll("[data-message-id]").length,
        scrollSweepMs: Math.round(performance.now() - begin),
        usedJsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      };
    });
    await cdp.send("HeapProfiler.collectGarbage");
    const browserMetrics = (await cdp.send("Performance.getMetrics")).metrics;
    const metric = (name) => browserMetrics.find((item) => item.name === name)?.value ?? null;
    return {
      ...metrics,
      loadToRowsMs,
      collectedJsHeapBytes: metric("JSHeapUsedSize"),
      domNodes: metric("Nodes"),
    };
  };
  const full = await sample("/chats/preview-large-room?fullHistory=1", 1199);
  const windowed = await sample("/chats/preview-large-room", 0);
  expect(full.mountedRows).toBe(1200);
  expect(windowed.mountedRows).toBeLessThan(80);
  console.log("large-chat baseline", JSON.stringify({ full, windowed }));
});
