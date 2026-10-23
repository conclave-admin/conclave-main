const { query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const { NOTIFICATION_TYPES } = require("../services/notification.service");

// What a caller may set. `activity_level` is constrained again by a CHECK in
// migration 015 — this is the friendly version of the same rule, so the client
// gets the list of allowed values instead of a database error message.
const ACTIVITY_LEVELS = ["all", "mentions", "none"];

// What a caller gets when they have never saved anything. Defined here rather
// than read out of an absent row so that "no preferences" and "preferences all
// set to their defaults" are literally the same object, and a client cannot tell
// the difference between a new account and a deliberately-configured one.
const DEFAULTS = {
  activity_level: "all",
  muted: {},
  push_enabled: true,
};

// Upsert rather than update-then-insert. Two concurrent saves on a first-ever
// write would otherwise race: both find no row, both insert, one gets a
// duplicate-key error from the loser. ON CONFLICT resolves that in the database
// instead of in application code.
const UPSERT = `
  INSERT INTO notification_preferences (user_id, activity_level, muted, push_enabled)
  VALUES ($1, $2, $3::jsonb, $4)
  ON CONFLICT (user_id) DO UPDATE
    SET activity_level = EXCLUDED.activity_level,
        muted           = EXCLUDED.muted,
        push_enabled    = EXCLUDED.push_enabled,
        updated_at      = NOW()
  RETURNING activity_level, muted, push_enabled, updated_at
`;

// ---------- getPreferences ----------
const getPreferences = asyncHandler(async (req, res) => {
  const result = await query(
    "SELECT activity_level, muted, push_enabled, updated_at FROM notification_preferences WHERE user_id = $1",
    [req.user.id],
  );

  // No row is not an error and not a null response — it is the default set.
  // Returning null here would push the same merge logic into every caller.
  if (result.rows.length === 0) {
    return ok(res, { ...DEFAULTS, updatedAt: null });
  }

  const row = result.rows[0];
  return ok(res, {
    activity_level: row.activity_level,
    // pg returns jsonb already parsed; the `|| {}` covers a row written before
    // the column existed rather than trusting the NOT NULL default to hold.
    muted: row.muted || {},
    push_enabled: row.push_enabled,
    updatedAt: row.updated_at || null,
  });
});

// ---------- updatePreferences ----------
// Same whitelist discipline as users.controller updateProfile: only these three
// fields, and an empty body is an error rather than a silent no-op, so a client
// that sends the wrong key finds out instead of believing it saved.
const updatePreferences = asyncHandler(async (req, res) => {
  const { activity_level: level, muted, push_enabled: push } = req.body;

  if (level === undefined && muted === undefined && push === undefined) {
    throw new ApiError(
      400,
      `No updatable fields provided. Allowed: activity_level, muted, push_enabled`,
    );
  }

  if (level !== undefined && !ACTIVITY_LEVELS.includes(level)) {
    throw new ApiError(
      400,
      `activity_level must be one of: ${ACTIVITY_LEVELS.join(", ")}`,
    );
  }

  if (muted !== undefined) {
    if (muted === null || typeof muted !== "object" || Array.isArray(muted)) {
      throw new ApiError(
        400,
        "muted must be an object mapping notification type to a boolean",
      );
    }
    // Both checks live here rather than in the migration because Postgres
    // forbids subqueries in CHECK constraints, so the shape of the values could
    // not be constrained there. An unknown key is rejected by name: storing
    // {"mentions": true, "whatever": true} would silently mute a type that
    // nothing reads, and the user would have set a switch that does nothing.
    for (const [key, value] of Object.entries(muted)) {
      if (!NOTIFICATION_TYPES.includes(key)) {
        throw new ApiError(400, `Unknown notification type: ${key}`);
      }
      if (typeof value !== "boolean") {
        throw new ApiError(400, `muted.${key} must be a boolean`);
      }
    }
  }

  // Read, merge, write. A single UPSERT with COALESCE over subselects would
  // avoid the round trip, but it means building one statement per combination
  // of which fields the caller sent, and the merge is three `=== undefined`
  // checks. Read-merge-write says the same thing and can be read.
  //
  // Falling back to DEFAULTS rather than null is what makes a partial PATCH on a
  // never-saved row produce the same result as a GET on one: the row comes into
  // existence already holding the values a reader would have synthesised.
  const existing = await query(
    "SELECT activity_level, muted, push_enabled FROM notification_preferences WHERE user_id = $1",
    [req.user.id],
  );
  const current = existing.rows.length > 0 ? existing.rows[0] : DEFAULTS;

  const result = await query(UPSERT, [
    req.user.id,
    level === undefined ? current.activity_level : level,
    JSON.stringify(muted === undefined ? current.muted || {} : muted),
    push === undefined ? current.push_enabled : push,
  ]);

  const row = result.rows[0];
  return ok(res, {
    activity_level: row.activity_level,
    muted: row.muted || {},
    push_enabled: row.push_enabled,
    updatedAt: row.updated_at,
  });
});

module.exports = {
  getPreferences,
  updatePreferences,
  ACTIVITY_LEVELS,
  DEFAULTS,
};
