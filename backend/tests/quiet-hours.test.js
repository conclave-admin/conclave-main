const test = require("node:test");
const assert = require("node:assert/strict");
const { isQuietNow, validateQuietHours } = require("../src/services/quietHours");
const { allowsInterruption } = require("../src/services/notificationPolicy.service");

const weekdays = [1, 2, 3, 4, 5];
const overnight = [{ days: weekdays, start: "22:00", end: "08:00" }];

test("weekly quiet hours cover selected days and overnight spill into the next day", () => {
  assert.equal(isQuietNow(overnight, "UTC", new Date("2026-11-25T23:30:00Z")), true);
  assert.equal(isQuietNow(overnight, "UTC", new Date("2026-11-26T07:59:00Z")), true);
  assert.equal(isQuietNow(overnight, "UTC", new Date("2026-11-26T08:00:00Z")), false);
  assert.equal(isQuietNow(overnight, "UTC", new Date("2026-11-29T23:00:00Z")), false);
});

test("weekly quiet hours use the selected timezone's local weekday and clock", () => {
  // 12:30 UTC is 08:30 in New York on this date (EDT).
  assert.equal(
    isQuietNow([{ days: [1], start: "08:00", end: "09:00" }], "America/New_York", new Date("2026-06-01T12:30:00Z")),
    true,
  );
});

test("daylight-saving transitions follow the wall clock without UTC drift", () => {
  const fallBack = [{ days: [0], start: "01:00", end: "02:00" }];
  assert.equal(isQuietNow(fallBack, "America/New_York", new Date("2026-11-01T05:30:00Z")), true);
  assert.equal(isQuietNow(fallBack, "America/New_York", new Date("2026-11-01T06:30:00Z")), true);
  assert.equal(isQuietNow(fallBack, "America/New_York", new Date("2026-11-01T07:00:00Z")), false);

  // The spring-forward clock skips 02:00. The schedule resumes at the next
  // valid local time and does not shift its configured end in UTC.
  const springForward = [{ days: [0], start: "01:00", end: "03:00" }];
  assert.equal(isQuietNow(springForward, "America/New_York", new Date("2026-03-08T06:30:00Z")), true);
  assert.equal(isQuietNow(springForward, "America/New_York", new Date("2026-03-08T07:00:00Z")), false);
});

test("bad schedules and zones are rejected and fail open in the evaluator", () => {
  assert.equal(validateQuietHours([], "UTC"), true);
  assert.equal(validateQuietHours([{ days: [1, 1], start: "22:00", end: "08:00" }], "UTC"), false);
  assert.equal(validateQuietHours([{ days: [7], start: "22:00", end: "08:00" }], "UTC"), false);
  assert.equal(validateQuietHours([{ days: [1], start: "08:00", end: "08:00" }], "UTC"), false);
  assert.equal(validateQuietHours([], "Mars/Olympus"), false);
  assert.equal(isQuietNow([null], "UTC", new Date()), false);
});

test("the server interruption policy suppresses matching quiet hours only", () => {
  const preferences = { quiet_hours: overnight, quiet_hours_timezone: "UTC" };
  assert.equal(allowsInterruption(preferences, "new_message", false, new Date("2026-11-25T23:30:00Z")), false);
  assert.equal(allowsInterruption(preferences, "new_message", false, new Date("2026-11-25T12:00:00Z")), true);
});
