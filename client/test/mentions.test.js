import test from "node:test";
import assert from "node:assert/strict";
import { mentionSegments } from "../src/lib/mentions.js";
const members = [
  { id: "1", display_name: "Amina Yusuf" },
  { id: "2", display_name: "Priya" },
];
test("recorded mentions with spaces link to the stable member ID", () => {
  assert.deepEqual(
    mentionSegments("Hi @Amina Yusuf, meet @Priya.", members, ["1", "2"]),
    [
      { text: "Hi " },
      { text: "@Amina Yusuf", userId: "1" },
      { text: ", meet " },
      { text: "@Priya", userId: "2" },
      { text: "." },
    ],
  );
});
test("unrecorded names, email addresses and partial names remain plain text", () => {
  for (const value of ["@Priya", "hello@Priya", "@Priyanka"])
    assert.deepEqual(mentionSegments(value, members, ["1"]), [{ text: value }]);
  assert.deepEqual(mentionSegments("hello@Priya @Priyanka", members, ["2"]), [
    { text: "hello@Priya @Priyanka" },
  ]);
});
test("ambiguous names do not guess a profile destination", () => {
  assert.deepEqual(
    mentionSegments(
      "@Priya",
      [...members, { id: "3", display_name: "Priya" }],
      ["2", "3"],
    ),
    [{ text: "@Priya" }],
  );
});
