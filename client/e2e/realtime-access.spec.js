import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("app-"),
    "requires the authenticated preview",
  );
  // Expose only the fixture event bus in the served test module. Production
  // code has no test dispatch hook and uses the real Socket.IO transport.
  await page.route("**/src/services/messages.service*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}\nconst fetchReceiptsForTest = getRoomReceiptSummaries; getRoomReceiptSummaries = async (...args) => { (window.__receiptSyncs ||= []).push(args); return fetchReceiptsForTest(...args); };`,
    });
  });
  await page.route("**/src/config/devPreview.js*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}\nwindow.__realtimeEvent = (name, payload) => { if (name === 'room:members' && payload?.userId === previewUser.id && ['removed','left'].includes(payload.action)) { const index = previewRooms.findIndex(room => room.id === payload.roomId); if (index >= 0) previewRooms.splice(index, 1); } listeners.get(name)?.forEach(handler => handler(payload)); }; window.__heartbeats = []; window.__activitySent = []; window.__reads = []; window.__delivered = []; const originalEmit = previewSocket.emit.bind(previewSocket); previewSocket.emit = (name, payload, ...args) => { if (name === 'heartbeat') window.__heartbeats.push(payload); if (name === 'message-read') window.__reads.push(payload); if (name === 'message-delivered') window.__delivered.push(payload); if (['typing','stop-typing','start-recording','stop-recording'].includes(name)) window.__activitySent.push({ name, ...payload }); return originalEmit(name, payload, ...args); };`,
    });
  });
});

test("removal immediately hides the composer and invalidates cached room access", async ({
  page,
}) => {
  await page.goto("/chats/preview-room");
  await expect(page.getByPlaceholder("Message…")).toBeVisible();
  await page.evaluate(() =>
    window.__realtimeEvent("room:members", {
      roomId: "preview-room",
      userId: "dev-preview-user",
      action: "removed",
    }),
  );
  await expect(
    page.getByText("You no longer have access to this conversation."),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Message…")).toHaveCount(0);
  await page.getByRole("link", { name: "Chats", exact: true }).first().click();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(
    page.getByRole("link").filter({ hasText: "Product & Engineering" }),
  ).toHaveCount(0);
});

test("removal while viewing room details immediately removes administration controls", async ({
  page,
}) => {
  await page.goto("/chats/preview-room/info");
  await expect(
    page.getByRole("heading", { name: "Room members" }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.__realtimeEvent("room:members", {
      roomId: "preview-room",
      userId: "dev-preview-user",
      action: "left",
    }),
  );
  await expect(
    page.getByText("You no longer have access to this conversation."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Room members" })).toHaveCount(
    0,
  );
});

test("DM status distinguishes online, viewing, typing, offline and disconnected uncertainty", async ({
  page,
}) => {
  await page.goto("/chats/preview-dm");
  await expect(
    page.getByRole("heading", { name: "Victor", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^Presence unavailable/)).toBeVisible();
  const snapshot = async (online, viewing, typing) =>
    page.evaluate(
      ({ online, viewing, typing }) =>
        window.__realtimeEvent("room-presence", {
          roomId: "preview-dm",
          available: true,
          onlineUserIds: online,
          viewingUserIds: viewing,
          typingUserIds: typing,
        }),
      { online, viewing, typing },
    );
  await snapshot(["dev-victor"], [], []);
  await expect(page.getByText(/^Online/).first()).toBeVisible();
  await snapshot(["dev-victor"], ["dev-victor"], []);
  await expect(page.getByText(/^Viewing this conversation/)).toBeVisible();
  await snapshot(["dev-victor"], ["dev-victor"], ["dev-victor"]);
  await expect(page.getByText(/^Typing…/)).toBeVisible();
  await snapshot([], [], []);
  await expect(page.getByText(/^Offline/)).toBeVisible();
  await page.evaluate(() => window.__realtimeEvent("disconnect"));
  await expect(page.getByText(/^Presence unavailable/)).toBeVisible();
  await page.evaluate(() => window.__realtimeEvent("connect"));
  await expect(page.getByText(/^Presence unavailable/)).toBeVisible();
  await snapshot(["dev-victor"], [], []);
  await expect(page.getByText(/^Online/).first()).toBeVisible();
});

test("background and resume report attention immediately and invalidate old rosters", async ({
  page,
}) => {
  await page.goto("/chats/preview-dm");
  await expect(
    page.getByRole("heading", { name: "Victor", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__realtimeEvent("room-presence", {
      roomId: "preview-dm",
      available: true,
      onlineUserIds: ["dev-victor"],
      viewingUserIds: ["dev-victor"],
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => page.evaluate(() => window.__heartbeats.at(-1)))
    .toMatchObject({ foreground: false, roomId: null });
  await expect(page.getByText(/^Presence unavailable/)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => page.evaluate(() => window.__heartbeats.at(-1)))
    .toMatchObject({ foreground: true, roomId: "preview-dm" });
  await expect(page.getByText(/^Presence unavailable/)).toBeVisible();
  await page.getByRole("link", { name: "Conversation details" }).click();
  await expect(
    page.getByRole("heading", { name: "About Victor" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__heartbeats.at(-1)?.roomId))
    .toBeNull();
});

test("typing is throttled and stops on empty input, blur, send and navigation", async ({
  page,
}) => {
  await page.goto("/chats/preview-dm");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeVisible();
  await composer.focus();
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    const field = document.querySelector('textarea[aria-label="Message"]');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    ).set;
    for (let index = 1; index <= 100; index++) {
      setter.call(field, "a".repeat(index));
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  expect(
    await page.evaluate(
      () =>
        window.__activitySent.filter((item) => item.name === "typing").length,
    ),
  ).toBe(1);
  await composer.fill("");
  expect(await page.evaluate(() => window.__activitySent.at(-1)?.name)).toBe(
    "stop-typing",
  );
  await composer.fill("blur me");
  await composer.evaluate((field) => field.blur());
  expect(await page.evaluate(() => window.__activitySent.at(-1)?.name)).toBe(
    "stop-typing",
  );
  await composer.fill("send me");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  expect(await page.evaluate(() => window.__activitySent.at(-1)?.name)).toBe(
    "stop-typing",
  );
  await composer.fill("navigate away");
  await page.getByRole("link", { name: "Conversation details" }).click();
  await expect(
    page.getByRole("heading", { name: "About Victor" }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__activitySent.at(-1)?.name)).toBe(
    "stop-typing",
  );
});

test("initial typing and recording snapshots expire and privacy changes clear all surfaces", async ({
  page,
}) => {
  await page.goto("/chats/preview-dm");
  await expect(
    page.getByRole("heading", { name: "Victor", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.__realtimeEvent("room-typing", {
      roomId: "preview-dm",
      activity: [{ userId: "dev-victor", kind: "typing", ttlMs: 1200 }],
    }),
  );
  await expect(
    page.getByText("Victor is typing", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Victor is typing", { exact: true })).toHaveCount(
    0,
  );
  await page.evaluate(() =>
    window.__realtimeEvent("room-typing", {
      roomId: "preview-dm",
      activity: [{ userId: "dev-victor", kind: "recording", ttlMs: 1200 }],
    }),
  );
  await expect(
    page.getByText("Victor is recording a voice message", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Victor is recording a voice message", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__realtimeEvent("privacy:changed", {
      userId: "dev-victor",
      hidden: true,
    });
    window.__realtimeEvent("start-recording", {
      roomId: "preview-dm",
      userId: "dev-victor",
      ttlMs: 5000,
    });
    window.__realtimeEvent("room-typing", {
      roomId: "preview-dm",
      typingUserIds: ["dev-victor"],
    });
  });
  await expect(page.getByText("Victor is typing", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Victor is recording a voice message", { exact: true }),
  ).toHaveCount(0);
});

async function fakeMicrophone(page, deferred = false) {
  await page.addInitScript(
    ({ deferred }) => {
      window.__tracksStopped = 0;
      const stream = {
        getTracks: () => [{ stop: () => window.__tracksStopped++ }],
      };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () =>
            deferred
              ? new Promise((resolve) => {
                  window.__allowMicrophone = () => resolve(stream);
                })
              : Promise.resolve(stream),
        },
      });
      window.MediaRecorder = class {
        state = "inactive";
        mimeType = "audio/webm";
        constructor() {
          window.__lastRecorder = this;
        }
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          queueMicrotask(() => {
            this.ondataavailable?.({
              data: new Blob(["voice"], { type: "audio/webm" }),
            });
            this.onstop?.();
          });
        }
      };
    },
    { deferred },
  );
}

test("recording announces live capture and stops the microphone when backgrounded", async ({
  page,
}) => {
  await fakeMicrophone(page);
  await page.goto("/chats/preview-dm");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    }),
  );
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Stop voice note recording",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.__activitySent.some((item) => item.name === "start-recording"),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(() => page.evaluate(() => window.__tracksStopped))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      window.__activitySent.some((item) => item.name === "stop-recording"),
    ),
  ).toBe(true);
});

test("a microphone permission result arriving after navigation releases the device", async ({
  page,
}) => {
  await fakeMicrophone(page, true);
  await page.goto("/chats/preview-dm");
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await page.getByRole("link", { name: "Conversation details" }).click();
  await expect(
    page.getByRole("heading", { name: "About Victor" }),
  ).toBeVisible();
  await page.evaluate(() => window.__allowMicrophone());
  await expect
    .poll(() => page.evaluate(() => window.__tracksStopped))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      window.__activitySent.some((item) => item.name === "start-recording"),
    ),
  ).toBe(false);
});

test("a recorder failure stops its indicator and releases the microphone", async ({
  page,
}) => {
  await fakeMicrophone(page);
  await page.goto("/chats/preview-dm");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    }),
  );
  await page
    .getByRole("button", { name: "Record voice note", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Stop voice note recording",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => window.__lastRecorder.onerror());
  await expect(
    page.getByText(
      "Voice recording stopped because the microphone or recorder became unavailable.",
    ),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__tracksStopped))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__activitySent.at(-1)?.name)).toBe(
    "stop-recording",
  );
});

test("delayed activity snapshots cannot restore an indicator after a newer stop", async ({
  page,
}) => {
  await page.goto("/chats/preview-dm");
  await expect(
    page.getByRole("heading", { name: "Victor", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.__realtimeEvent("room-typing", {
      roomId: "preview-dm",
      activityVersion: 10,
      activity: [{ userId: "dev-victor", kind: "typing", ttlMs: 5000 }],
    }),
  );
  await expect(
    page.getByText("Victor is typing", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__realtimeEvent("room-typing", {
      roomId: "preview-dm",
      activityVersion: 11,
      activity: [],
    });
    window.__realtimeEvent("room-typing", {
      roomId: "preview-dm",
      activityVersion: 10,
      activity: [{ userId: "dev-victor", kind: "typing", ttlMs: 5000 }],
    });
    window.__realtimeEvent("start-recording", {
      roomId: "preview-dm",
      userId: "dev-victor",
      activityVersion: 10,
      ttlMs: 5000,
    });
    window.__realtimeEvent("room-presence", {
      roomId: "preview-dm",
      available: true,
      activityVersion: 10,
      onlineUserIds: ["dev-victor"],
      activity: [{ userId: "dev-victor", kind: "typing", ttlMs: 5000 }],
    });
  });
  await expect(page.getByText("Victor is typing", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Victor is recording a voice message", { exact: true }),
  ).toHaveCount(0);
});

test("hidden and unfocused timelines wait for resume before acknowledging visible messages", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__receiptHidden = true;
    window.__receiptFocused = false;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (window.__receiptHidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => window.__receiptFocused,
    });
  });
  await page.goto("/chats/preview-dm");
  await expect(
    page.getByRole("heading", { name: "Victor", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__reads.length)).toBe(0);
  await page.evaluate(() => {
    window.__receiptHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await page.evaluate(() => window.__reads.length)).toBe(0);
  await page.evaluate(() => {
    window.__receiptFocused = true;
    window.dispatchEvent(new Event("focus"));
  });
  await expect
    .poll(() => page.evaluate(() => window.__reads.length))
    .toBeGreaterThan(0);
  const before = await page.evaluate(() => window.__reads.length);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await page.evaluate(() => window.__reads.length)).toBe(before);
});

test("message information shows recipient details and group ticks ignore stale summaries", async ({
  page,
}) => {
  await page.goto("/chats/preview-dm");
  const button = page
    .getByRole("button", { name: "Message info", exact: true })
    .first();
  await expect(button).toBeVisible();
  const id = await button.evaluate(
    (node) => node.closest("[data-message-id]").dataset.messageId,
  );
  const snapshot = {
    recipient_count: 2,
    delivered_count: 1,
    read_count: 1,
    history_complete: true,
    version: 3,
  };
  await page.evaluate(
    ({ id, snapshot }) =>
      window.__realtimeEvent("message:receipts", {
        roomId: "preview-dm",
        receipts: [{ messageId: id, receipt_summary: snapshot }],
      }),
    { id, snapshot },
  );
  await expect(button.locator("[data-message-status]")).toHaveAttribute(
    "data-message-status",
    "sent",
  );
  await page.evaluate(
    ({ id, snapshot }) =>
      window.__realtimeEvent("message:receipts", {
        roomId: "preview-dm",
        receipts: [
          {
            messageId: id,
            receipt_summary: {
              ...snapshot,
              delivered_count: 2,
              read_count: 2,
              version: 4,
            },
          },
        ],
      }),
    { id, snapshot },
  );
  await expect(button.locator("[data-message-status]")).toHaveAttribute(
    "data-message-status",
    "read",
  );
  await page.evaluate(
    ({ id, snapshot }) =>
      window.__realtimeEvent("message:receipts", {
        roomId: "preview-dm",
        receipts: [{ messageId: id, receipt_summary: snapshot }],
      }),
    { id, snapshot },
  );
  await expect(button.locator("[data-message-status]")).toHaveAttribute(
    "data-message-status",
    "read",
  );
  await button.click();
  await expect(
    page.getByRole("dialog", { name: "Message information" }),
  ).toBeVisible();
  await expect(page.getByText("Not delivered", { exact: true })).toBeVisible();
  await expect(page.getByText(/Recipient history is incomplete/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("reconnect refreshes historical receipt summaries and retries cached delivery acknowledgements", async ({
  page,
}) => {
  await page.goto("/chats/preview-dm");
  const button = page
    .getByRole("button", { name: "Message info", exact: true })
    .last();
  await expect(button).toBeVisible();
  const id = await button.evaluate(
    (node) => node.closest("[data-message-id]").dataset.messageId,
  );
  await page.goto(`/chats/preview-dm?message=${encodeURIComponent(id)}`);
  await expect(
    page.getByText("Viewing a shared message", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(`[data-message-id="${id}"]`)).toBeVisible();
  const before = await page.evaluate(() => window.__delivered.length);
  await page.evaluate(() => {
    window.__realtimeEvent("disconnect");
    window.__realtimeEvent("connect");
  });
  await expect
    .poll(() => page.evaluate(() => window.__receiptSyncs?.length || 0))
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.__delivered.length))
    .toBeGreaterThan(before);
  expect(
    await page.evaluate(
      (id) =>
        window.__receiptSyncs.some(
          ([roomId, ids]) => roomId === "preview-dm" && ids.includes(id),
        ),
      id,
    ),
  ).toBe(true);
});

test("personal clearing hides cached chat previews and ignores late pre-clear updates", async ({
  page,
}) => {
  await page.goto("/chats");
  const room = page
    .getByRole("link")
    .filter({ hasText: "Product & Engineering" })
    .first();
  await expect(room).toBeVisible();
  await page.evaluate(async () => {
    const { applyAccountClear } =
      await import("/src/lib/clearedConversations.js");
    applyAccountClear(
      "dev-preview-user",
      "preview-room",
      "999999",
      "2026-10-23T12:00:00Z",
    );
  });
  await expect(room).not.toContainText(
    "On it—validating the config and update by EOD.",
  );
  await page.evaluate(() =>
    window.__realtimeEvent("chat:updated", {
      roomId: "preview-room",
      roomSequence: "1",
      unreadCount: 3,
      lastMessage: {
        id: "late-cleared",
        room_sequence: "1",
        content: "CLEARED PREVIEW MUST NOT RETURN",
        created_at: "2026-10-08T09:37:00Z",
      },
    }),
  );
  await expect(
    page.getByText("CLEARED PREVIEW MUST NOT RETURN", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("link").filter({ hasText: "Product & Engineering" }).first(),
  ).not.toContainText("On it—validating the config and update by EOD.");
});
