const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMediaPage, mediaCursor } = require("../src/utils/mediaPagination");
const roomId = "10000000-0000-4000-8000-000000000001";
const row = {
  id: "20000000-0000-4000-8000-000000000001",
  room_sequence: "9007199254740993",
};
test("shared media defaults and cursor preserve bigint precision and section boundaries", () => {
  assert.deepEqual(parseMediaPage({}, roomId), {
    kind: "media",
    limit: 24,
    after: null,
    cursor: null,
  });
  const cursor = mediaCursor(row, roomId, "audio", null);
  assert.equal(
    parseMediaPage({ kind: "audio", cursor, limit: "100" }, roomId).cursor
      .sequence,
    row.room_sequence,
  );
  for (const input of [
    { kind: "documents", cursor },
    { kind: "audio", cursor, after: "2026-10-21T00:00:00Z" },
  ])
    assert.throws(() => parseMediaPage(input, roomId), { status: 400 });
  assert.throws(
    () => parseMediaPage({ kind: "audio", cursor }, "different-room"),
    { status: 400 },
  );
});
test("shared file queries reject invalid sections, limits, cursors and dates", () => {
  for (const input of [
    { kind: "all" },
    { kind: [] },
    { limit: "0" },
    { limit: "101" },
    { limit: "1.5" },
    { limit: ["2"] },
    { cursor: "{}" },
    { cursor: "a".repeat(1001) },
    { after: "not-a-date" },
    { after: [] },
  ])
    assert.throws(() => parseMediaPage(input, roomId), { status: 400 });
});
