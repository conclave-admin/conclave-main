import { containDialog, isTopDialog } from "../src/lib/dialogFocus.js";
import { conversationMessageVisible } from "../src/lib/clearedConversations.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readDraft, writeDraft } from "../src/lib/drafts.js";
import { readPosition, savePosition } from "../src/lib/readingPosition.js";
import emojiData from "@emoji-mart/data" with { type: "json" };
test("drafts preserve text and reply metadata without crossing accounts or rooms", () => {
  const old = globalThis.localStorage,
    win = globalThis.window;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  globalThis.window = { dispatchEvent: () => {} };
  try {
    writeDraft("a", "room", "Unsent **text**", {
      id: "source",
      content: "reply",
    });
    assert.equal(readDraft("a", "room").text, "Unsent **text**");
    assert.equal(readDraft("a", "room").reply.id, "source");
    assert.equal(readDraft("b", "room").text, "");
    assert.equal(readDraft("a", "other").text, "");
    writeDraft("a", "room", "");
    assert.equal(readDraft("a", "room").text, "");
  } finally {
    globalThis.localStorage = old;
    globalThis.window = win;
  }
});
test("draft storage failures do not crash composing and corrupt data is ignored", () => {
  const old = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => "{bad",
    setItem: () => {
      throw new Error("Quota");
    },
    removeItem: () => {
      throw new Error("Quota");
    },
  };
  try {
    assert.equal(readDraft("a", "room").text, "");
    assert.doesNotThrow(() => writeDraft("a", "room", "Pending"));
  } finally {
    globalThis.localStorage = old;
  }
});
test("reading positions preserve a message offset and are scoped to the account", () => {
  const old = globalThis.localStorage,
    values = new Map();
  globalThis.localStorage = {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
  };
  try {
    savePosition("a", "room", { id: "message", offset: -18, atBottom: false });
    assert.equal(readPosition("a", "room").offset, -18);
    assert.equal(readPosition("b", "room"), null);
    assert.equal(readPosition("a", "other"), null);
  } finally {
    globalThis.localStorage = old;
  }
});
test("Emoji Mart provides native reactions including skin tones", () => {
  const variants = Object.values(emojiData.emojis).flatMap((emoji) =>
    emoji.skins.map((skin) => skin.native),
  );
  const available = new Set(variants);
  assert.ok(available.size > 3000);
  for (const emoji of ["👍", "👍🏽", "🎉", "❤️", "🚀"])
    assert.ok(available.has(emoji));
});

test("expired messages are hidden locally, including from offline history", () => {
  assert.equal(
    conversationMessageVisible(
      {
        id: "m",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
      "u",
      "r",
    ),
    false,
  );
  assert.equal(
    conversationMessageVisible(
      {
        id: "m",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      "u",
      "r",
    ),
    true,
  );
});

test("nested dialogs restore background isolation even when the outer dialog unmounts first", () => {
  const original = globalThis.document,
    root = { inert: false },
    one = { inert: false },
    two = { inert: false };
  globalThis.document = {
    body: { children: [root, one, two] },
    addEventListener() {},
    removeEventListener() {},
  };
  const panel1 = { parentElement: one },
    panel2 = { parentElement: two };
  try {
    const close1 = containDialog(panel1);
    assert.equal(root.inert, true);
    assert.equal(one.inert, false);
    const close2 = containDialog(panel2);
    assert.equal(one.inert, true);
    assert.equal(isTopDialog(panel2), true);
    close1();
    assert.equal(root.inert, true);
    assert.equal(two.inert, false);
    close2();
    assert.equal(root.inert, false);
    assert.equal(one.inert, false);
    assert.equal(two.inert, false);
  } finally {
    globalThis.document = original;
  }
});
