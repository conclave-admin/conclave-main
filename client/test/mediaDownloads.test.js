import test from "node:test";
import assert from "node:assert/strict";
import { createMediaDownloads } from "../src/lib/mediaDownloads.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function harness(overrides = {}) {
  const stored = new Map();
  let fetches = 0;
  let snapshot;
  const attachment = {
    id: "photo",
    url: "r2://private/photo",
    filename: "photo.jpg",
  };
  const manager = createMediaDownloads({
    keyFor: (a) => a.url,
    read: async (a) => stored.get(a.url) || null,
    fetchFile: async (_, options) => {
      fetches++;
      options.onProgress(0.5);
      return new Blob(["original"]);
    },
    cache: async (a, blob) => {
      stored.set(a.url, blob);
      return true;
    },
    ...overrides,
  });
  const unsubscribe = manager.subscribe(attachment, (state) => {
    snapshot = state;
  });
  return {
    manager,
    attachment,
    stored,
    unsubscribe,
    get fetches() {
      return fetches;
    },
    get state() {
      return snapshot;
    },
  };
}
test("originals are on demand, shared across consumers, cached and reopened without another request", async () => {
  const h = harness();
  await new Promise(queueMicrotask);
  assert.equal(h.fetches, 0);
  assert.equal(h.state.status, "available");
  const [first, second] = await Promise.all([
    h.manager.start(h.attachment),
    h.manager.start(h.attachment),
  ]);
  assert.equal(first, second);
  assert.equal(h.fetches, 1);
  assert.equal(h.state.status, "downloaded");
  assert.equal(h.state.persisted, true);
  h.unsubscribe();
  await new Promise(queueMicrotask);
  h.manager.subscribe(h.attachment, () => {});
  await h.manager.start(h.attachment);
  assert.equal(h.fetches, 1);
});
test("cancel aborts transport, ignores late bytes and allows retry", async () => {
  const gate = deferred();
  let signal;
  let count = 0;
  const h = harness({
    fetchFile: async (_, options) => {
      signal = options.signal;
      count++;
      return gate.promise;
    },
  });
  const pending = h.manager.start(h.attachment);
  await new Promise(queueMicrotask);
  h.manager.cancel(h.attachment);
  assert.equal(signal.aborted, true);
  gate.resolve(new Blob(["late"]));
  await pending;
  assert.equal(h.state.status, "available");
  assert.equal(h.stored.size, 0);
  await h.manager.start(h.attachment);
  assert.equal(count, 2);
  assert.equal(h.state.status, "downloaded");
});
test("failure is visible and a retry downloads successfully", async () => {
  let fail = true;
  const h = harness({
    fetchFile: async () => {
      if (fail) throw new Error("Offline");
      return new Blob(["ok"]);
    },
  });
  await h.manager.start(h.attachment);
  assert.equal(h.state.status, "failed");
  assert.equal(h.state.error, "Offline");
  fail = false;
  await h.manager.start(h.attachment);
  assert.equal(h.state.status, "downloaded");
});
test("quota failures distinguish a temporary copy from an offline copy", async () => {
  const h = harness({ cache: async () => false });
  await h.manager.start(h.attachment);
  assert.equal(h.state.status, "downloaded");
  assert.equal(h.state.persisted, false);
  assert.ok(h.state.blob);
  h.manager.recheck();
  await new Promise(queueMicrotask);
  assert.equal(h.state.status, "available");
  assert.equal(h.state.blob, null);
});
test("eviction and clearing remove stale downloaded state and stop in-flight work", async () => {
  const h = harness();
  await h.manager.start(h.attachment);
  h.stored.clear();
  h.manager.invalidate([h.attachment.url]);
  assert.equal(h.state.status, "available");
  assert.equal(h.state.blob, null);
  await h.manager.start(h.attachment);
  assert.equal(h.fetches, 2);
  h.manager.invalidate();
  assert.equal(h.state.status, "available");
});
test("account stop prevents late downloads from repopulating storage", async () => {
  const gate = deferred();
  const h = harness({ fetchFile: () => gate.promise });
  const pending = h.manager.start(h.attachment);
  await new Promise(queueMicrotask);
  h.manager.stop();
  gate.resolve(new Blob(["late"]));
  await pending;
  assert.equal(h.stored.size, 0);
  assert.equal(h.state.blob, null);
});

test("network policy cancels automatic transfers but manual opens promote and preserve them", async () => {
  const gate = deferred();
  let signal;
  const h = harness({
    fetchFile: async (_, options) => {
      signal = options.signal;
      return gate.promise;
    },
  });
  const automatic = h.manager.start(h.attachment, { automatic: true });
  await new Promise(queueMicrotask);
  h.manager.cancelAutomatic(() => true);
  assert.equal(signal.aborted, true);
  gate.resolve(new Blob(["cancelled"]));
  await automatic;
  const gate2 = deferred();
  let manualSignal;
  const manual = harness({
    fetchFile: async (_, options) => {
      manualSignal = options.signal;
      return gate2.promise;
    },
  });
  const active = manual.manager.start(manual.attachment, { automatic: true });
  await new Promise(queueMicrotask);
  const promoted = manual.manager.start(manual.attachment);
  manual.manager.cancelAutomatic(() => true);
  assert.equal(manualSignal.aborted, false);
  gate2.resolve(new Blob(["manual"]));
  await Promise.all([active, promoted]);
  assert.equal(manual.state.status, "downloaded");
});
