import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("the ready-page asset handshake claims its document and caches only public assets", async () => {
  const handlers = new Map();
  const steps = [];
  const fetched = [];
  const pending = [];
  const origin = "https://conclave.example.test";
  const cache = {
    match: async () => null,
    put: async () => {
      steps.push("cached");
    },
  };
  const source = await readFile(
    new URL("../public/service-worker.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, {
    URL,
    self: {
      location: { origin },
      clients: {
        claim: async () => {
          steps.push("claimed");
        },
      },
      addEventListener: (name, handler) => handlers.set(name, handler),
    },
    caches: {
      open: async () => {
        steps.push("opened");
        return cache;
      },
    },
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true };
    },
  });
  handlers.get("message")({
    data: {
      type: "CACHE_ASSETS",
      urls: [
        `${origin}/assets/room.js`,
        `${origin}/api/messages`,
        "https://other.example.test/assets/private.js",
      ],
    },
    waitUntil: (work) => pending.push(work),
  });
  await Promise.all(pending);
  assert.equal(steps[0], "claimed");
  assert.deepEqual(fetched, [`${origin}/assets/room.js`]);
  assert.ok(steps.includes("cached"));
});

async function pushWorker() {
  const handlers = new Map();
  const shown = [];
  const messages = [];
  const opened = [];
  const requests = [];
  let binding = {
    bindingId: "binding",
    renewalToken: "renewal",
    apiBase: "https://api.example.test/api",
  };
  let clients = [];
  const context = {
    URL,
    Date,
    Uint8Array,
    atob,
    self: {
      location: { origin: "https://conclave.example.test" },
      registration: {
        showNotification: async (title, options) =>
          shown.push({ title, ...options }),
        pushManager: {
          subscribe: async () => ({
            toJSON: () => ({ endpoint: "https://fcm.googleapis.com/rotated" }),
          }),
        },
      },
      clients: {
        matchAll: async () => clients,
        openWindow: async (url) => opened.push(url),
      },
      addEventListener: (name, handler) => handlers.set(name, handler),
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () =>
          url.endsWith("/config")
            ? { data: { configured: true, publicKey: "AQID" } }
            : { data: { bindingId: "binding", renewalToken: "new-renewal" } },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(
    await readFile(
      new URL("../public/service-worker.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  context.pushState = async (value, write) => {
    if (write) binding = value;
    return binding;
  };
  const event = async (name, extra) => {
    let work;
    handlers.get(name)({
      ...extra,
      waitUntil: (value) => {
        work = value;
      },
    });
    await work;
  };
  return {
    context,
    shown,
    messages,
    opened,
    requests,
    event,
    setBinding: (value) => {
      binding = value;
    },
    binding: () => binding,
    setClients: (value) => {
      clients = value;
    },
  };
}
test("closed-app push ignores stale account bindings and falls back to generic content", async () => {
  const f = await pushWorker();
  await f.event("push", {
    data: {
      json: () => ({
        id: "notification",
        bindingId: "other",
        body: "Private secret",
      }),
    },
  });
  assert.equal(f.shown.length, 0);
  // No title/body/tag in the payload falls back to the fully generic form —
  // the same shape the server still sends when the recipient disabled
  // previews or the subject type has nothing safe to show.
  await f.event("push", {
    data: {
      json: () => ({
        id: "notification",
        bindingId: "binding",
      }),
    },
  });
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].title, "Conclave");
  assert.equal(f.shown[0].body, "You have new activity in Conclave");
  assert.equal(f.shown[0].tag, "conclave:notification");
  assert.equal(f.shown[0].renotify, true);
  assert.equal(f.shown[0].icon, "/apple-touch-icon.png");
  f.setBinding(null);
  await f.event("push", {
    data: { json: () => ({ id: "later", bindingId: "binding" }) },
  });
  assert.equal(f.shown.length, 1);
});
test("an opted-in preview payload is shown with its conversation-grouped tag", async () => {
  const f = await pushWorker();
  await f.event("push", {
    data: {
      json: () => ({
        id: "notification",
        bindingId: "binding",
        title: "Priya Shah",
        body: "Can you review the draft before standup?",
        tag: "conclave:room:room-1",
        actionToken: "A".repeat(43),
        roomId: "00000000-0000-0000-0000-000000000001",
      }),
    },
  });
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].title, "Priya Shah");
  assert.equal(
    f.shown[0].body,
    "Can you review the draft before standup?",
  );
  assert.equal(f.shown[0].tag, "conclave:room:room-1");
  assert.equal(f.shown[0].renotify, true);
  assert.equal(JSON.stringify(f.shown[0].actions), JSON.stringify([
    { action: "mark-read", title: "Mark as read" },
    { action: "open-chat", title: "Open chat" },
  ]));
});
test("the mark-read notification action uses its scoped capability and does not open a window", async () => {
  const f = await pushWorker();
  const token = "A".repeat(43);
  await f.event("notificationclick", {
    action: "mark-read",
    notification: {
      close() {},
      data: { bindingId: "binding", actionToken: token, roomId: "00000000-0000-0000-0000-000000000001" },
    },
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "https://api.example.test/api/push/actions/mark-read");
  assert.equal(JSON.parse(f.requests[0].options.body).token, token);
  assert.deepEqual(f.opened, []);
});
test("the open-chat notification action navigates only to the same-origin conversation", async () => {
  const f = await pushWorker();
  let target;
  f.setClients([{
    focused: false,
    visibilityState: "hidden",
    url: "https://conclave.example.test/notifications",
    focus: async () => {},
    navigate: async (url) => { target = url; },
    postMessage: () => {},
  }]);
  await f.event("notificationclick", {
    action: "open-chat",
    notification: {
      close() {},
      data: { bindingId: "binding", roomId: "00000000-0000-0000-0000-000000000001" },
    },
  });
  assert.equal(target, "https://conclave.example.test/chats/00000000-0000-0000-0000-000000000001");
});
test("foreground conversation suppresses interruption and notification clicks remain on this origin", async () => {
  const f = await pushWorker();
  let focused = false;
  let target;
  const client = {
    focused: true,
    visibilityState: "visible",
    url: "https://conclave.example.test/chats/room",
    postMessage: (value) => f.messages.push(value),
    focus: async () => {
      focused = true;
    },
    navigate: async (url) => {
      target = url;
    },
  };
  f.setClients([client]);
  await f.event("push", {
    data: { json: () => ({ id: "n", bindingId: "binding", roomId: "room" }) },
  });
  assert.equal(f.shown.length, 0);
  assert.equal(f.messages[0].type, "SYNC_REQUEST");
  await f.event("notificationclick", {
    notification: {
      close() {},
      data: { bindingId: "binding", url: "https://evil.test/" },
    },
  });
  assert.equal(focused, true);
  assert.equal(target, "https://conclave.example.test/notifications");
});
test("subscription change renews its scoped credential without storing API login tokens", async () => {
  const f = await pushWorker();
  await f.event("pushsubscriptionchange", {});
  assert.equal(f.binding().renewalToken, "new-renewal");
  assert.equal(f.binding().bindingId, "binding");
  assert.equal(f.binding().accessToken, undefined);
});
