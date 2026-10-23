import test from "node:test";
import assert from "node:assert/strict";
import { readStatus, newerReceipt } from "../src/lib/messageMeta.js";
import {
  activeReadView,
  messageIsVisible,
  observeMessageReads,
} from "../src/lib/messageReads.js";

const message = { id: "m", sender_id: "me", room_sequence: 5 };
const summary = (overrides) => ({
  recipient_count: 2,
  delivered_count: 0,
  read_count: 0,
  history_complete: true,
  version: 1,
  ...overrides,
});
test("group ticks require every original recipient, with reading implying delivery", () => {
  const status = (value) =>
    readStatus({ ...message, receipt_summary: summary(value) }, [], "me");
  assert.equal(status({ delivered_count: 1, read_count: 1 }), "sent");
  assert.equal(status({ delivered_count: 2, read_count: 1 }), "delivered");
  assert.equal(status({ delivered_count: 2, read_count: 2 }), "read");
  assert.equal(status({ recipient_count: 0 }), "sent");
  assert.equal(
    status({ delivered_count: 2, read_count: 2, history_complete: false }),
    "sent",
  );
  assert.equal(
    readStatus(
      message,
      [
        { id: "a", last_seen_sequence: 5 },
        { id: "b", last_seen_sequence: 0 },
      ],
      "me",
    ),
    "sent",
  );
});
test("membership and stale updates cannot rewrite send-time receipt status; outbox states take precedence", () => {
  const saved = {
    ...message,
    receipt_summary: summary({ delivered_count: 2, read_count: 2, version: 5 }),
  };
  assert.equal(
    readStatus(saved, [{ id: "new", last_seen_sequence: 0 }], "me"),
    "read",
  );
  assert.equal(
    readStatus(saved, [], "me", new Set(), new Set(), new Set(["m"])),
    "queued",
  );
  assert.equal(readStatus(saved, [], "me", new Set(["m"])), "pending");
  assert.equal(
    readStatus(saved, [], "me", new Set(), new Set(["m"])),
    "failed",
  );
  assert.equal(
    newerReceipt(saved.receipt_summary, summary({ version: 4 })),
    saved.receipt_summary,
  );
  assert.equal(
    newerReceipt(saved.receipt_summary, null),
    saved.receipt_summary,
  );
  assert.equal(readStatus(saved, [], "other"), null);
});
function fixture() {
  const doc = new EventTarget();
  doc.visibilityState = "visible";
  doc.focused = true;
  doc.hasFocus = () => doc.focused;
  const win = new EventTarget();
  win.navigator = { onLine: true };
  win.innerHeight = 800;
  win.innerWidth = 400;
  const timers = new Map();
  let timer = 0;
  win.setTimeout = (callback) => {
    timers.set(++timer, callback);
    return timer;
  };
  win.clearTimeout = (id) => timers.delete(id);
  const rect = { top: 100, bottom: 300, left: 0, right: 400, height: 200 };
  const node = { getAttribute: () => "m", getBoundingClientRect: () => rect };
  const container = new EventTarget();
  container.getBoundingClientRect = () => ({
    top: 100,
    bottom: 500,
    left: 0,
    right: 400,
  });
  container.querySelectorAll = () => [node];
  return { doc, win, rect, node, container, timers };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
test("only a visible focused online application view qualifies for read acknowledgements", () => {
  const f = fixture();
  assert.equal(activeReadView(f.doc, f.win), true);
  f.doc.visibilityState = "hidden";
  assert.equal(activeReadView(f.doc, f.win), false);
  f.doc.visibilityState = "visible";
  f.doc.focused = false;
  assert.equal(activeReadView(f.doc, f.win), false);
  f.doc.focused = true;
  f.doc.querySelector = () => ({});
  assert.equal(
    activeReadView(f.doc, f.win),
    false,
    "modal overlays cover the conversation",
  );
  f.doc.querySelector = () => null;
  f.win.navigator.onLine = false;
  assert.equal(activeReadView(f.doc, f.win), false);
  f.rect.top = 600;
  f.rect.bottom = 800;
  assert.equal(messageIsVisible(f.node, f.container, f.win), false);
  f.rect.top = 100;
  f.rect.bottom = 2100;
  f.rect.height = 2000;
  assert.equal(
    messageIsVisible(f.node, f.container, f.win),
    true,
    "long messages can be read without 55% of the entire bubble fitting",
  );
});
test("resume rechecks unchanged geometry, and successful reads are deduplicated", async () => {
  const f = fixture();
  f.doc.visibilityState = "hidden";
  const confirmed = new Set();
  let calls = 0;
  const dispose = observeMessageReads({
    ...f,
    confirmed,
    messages: new Map([["m", message]]),
    onRead: async () => {
      calls++;
      return true;
    },
  });
  await flush();
  assert.equal(calls, 0);
  f.doc.visibilityState = "visible";
  f.doc.dispatchEvent(new Event("visibilitychange"));
  await flush();
  assert.equal(calls, 1);
  assert.equal(confirmed.has("m"), true);
  f.win.dispatchEvent(new Event("focus"));
  f.container.dispatchEvent(new Event("scroll"));
  await flush();
  assert.equal(calls, 1);
  dispose();
  assert.equal(f.timers.size, 0);
});
test("failed or offline reads are retried on resume, and covered timelines do not send reads", async () => {
  const f = fixture();
  const confirmed = new Set();
  let calls = 0;
  const options = {
    ...f,
    confirmed,
    messages: new Map([["m", message]]),
    onRead: async () => ++calls > 1,
  };
  let dispose = observeMessageReads({ ...options, enabled: false });
  await flush();
  assert.equal(calls, 0);
  dispose();
  dispose = observeMessageReads(options);
  await flush();
  assert.equal(calls, 1);
  assert.equal(confirmed.has("m"), false);
  f.win.navigator.onLine = false;
  f.container.dispatchEvent(new Event("scroll"));
  await flush();
  assert.equal(calls, 1);
  f.win.navigator.onLine = true;
  f.win.dispatchEvent(new Event("online"));
  await flush();
  assert.equal(calls, 2);
  assert.equal(confirmed.has("m"), true);
  dispose();
  assert.equal(f.timers.size, 0);
});

test("in-flight reads survive timeline rerenders without duplicate sends or lost acknowledgements", async () => {
  const f = fixture();
  const confirmed = new Set();
  const inFlight = new Set();
  let resolve;
  let calls = 0;
  const options = {
    ...f,
    confirmed,
    inFlight,
    messages: new Map([["m", message]]),
    onRead: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const first = observeMessageReads(options);
  await flush();
  assert.equal(calls, 1);
  first();
  const second = observeMessageReads(options);
  await flush();
  assert.equal(calls, 1);
  resolve(true);
  await flush();
  assert.equal(confirmed.has("m"), true);
  assert.equal(inFlight.size, 0);
  second();
});
