import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAccountClear,
  getAccountClearSequence,
  conversationMessageVisible,
  clearConversationForMe,
} from "../src/lib/clearedConversations.js";
test("account clearing is precise, monotonic and isolated by account and room", () => {
  const original = {
    storage: globalThis.localStorage,
    window: globalThis.window,
  };
  const values = new Map(),
    events = [];
  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  globalThis.window = { dispatchEvent: (event) => events.push(event.detail) };
  try {
    const high = "9007199254740993";
    applyAccountClear("alice", "room", high);
    applyAccountClear("alice", "room", "1");
    assert.equal(getAccountClearSequence("alice", "room"), high);
    assert.equal(events.length, 1);
    assert.equal(getAccountClearSequence("bob", "room"), "0");
    assert.equal(getAccountClearSequence("alice", "other"), "0");
    const row = { created_at: new Date().toISOString(), room_sequence: high };
    assert.equal(conversationMessageVisible(row, "alice", "room"), false);
    assert.equal(
      conversationMessageVisible(
        { ...row, room_sequence: "9007199254740994" },
        "alice",
        "room",
      ),
      true,
    );
    assert.equal(
      conversationMessageVisible(
        { ...row, room_sequence: undefined },
        "alice",
        "room",
      ),
      false,
    );
    assert.equal(
      conversationMessageVisible(
        { ...row, _optimistic: true },
        "alice",
        "room",
      ),
      true,
    );
    assert.equal(conversationMessageVisible(row, "bob", "room"), true);
  } finally {
    globalThis.localStorage = original.storage;
    globalThis.window = original.window;
  }
});
test("device-only clearing stays local and preserves pending drafts", async () => {
  const original = {
    storage: globalThis.localStorage,
    window: globalThis.window,
  };
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  globalThis.window = { dispatchEvent: () => {} };
  try {
    await clearConversationForMe("alice", "room", "device");
    const old = { created_at: "2020-01-01", room_sequence: "1" };
    assert.equal(conversationMessageVisible(old, "alice", "room"), false);
    assert.equal(
      conversationMessageVisible(
        { ...old, _optimistic: true },
        "alice",
        "room",
      ),
      true,
    );
    assert.equal(conversationMessageVisible(old, "bob", "room"), true);
    assert.equal(getAccountClearSequence("alice", "room"), "0");
  } finally {
    globalThis.localStorage = original.storage;
    globalThis.window = original.window;
  }
});

test("clearing legacy unsequenced history works even with a zero sequence", () => {
  const original = {
    storage: globalThis.localStorage,
    window: globalThis.window,
  };
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  globalThis.window = { dispatchEvent: () => {} };
  try {
    const row = { created_at: "2020-01-01" };
    assert.equal(
      conversationMessageVisible(row, "legacy-user", "legacy-room"),
      true,
    );
    applyAccountClear(
      "legacy-user",
      "legacy-room",
      "0",
      "2026-10-23T12:00:00Z",
    );
    assert.equal(
      conversationMessageVisible(row, "legacy-user", "legacy-room"),
      false,
    );
    assert.equal(
      conversationMessageVisible(
        { ...row, room_sequence: "1" },
        "legacy-user",
        "legacy-room",
      ),
      true,
    );
    assert.equal(
      conversationMessageVisible(
        { ...row, _optimistic: true },
        "legacy-user",
        "legacy-room",
      ),
      true,
    );
  } finally {
    globalThis.localStorage = original.storage;
    globalThis.window = original.window;
  }
});
