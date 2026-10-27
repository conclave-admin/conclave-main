const { pool, query } = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const ApiError = require("../utils/ApiError");
const { presentNotifications, emitNotification } = require("../services/notification.service");
const {
  attachPins,
  getDecisionPayload,
  pinDecision,
  unpinDecision,
} = require("../services/decisionPin.service");

// The Decisions Layer — promote any message to a tagged, searchable
// Decision stored outside the chat timeline. This is one of the three
// differentiator features from the PKB (see docs/).

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decisionFields(input) {
  if (typeof input.title !== "string" || typeof input.body !== "string")
    throw new ApiError(400, "Decision title and body must be text");
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || title.length > 140 || !body || body.length > 10000)
    throw new ApiError(400, "Give the decision a title (up to 140 characters) and body (up to 10,000 characters)");
  if (!Array.isArray(input.tags) || input.tags.length > 10)
    throw new ApiError(400, "Use at most 10 tags");
  if (input.tags.some((tag) => typeof tag !== "string"))
    throw new ApiError(400, "Tags must be text");
  const tags = [...new Set(input.tags.map((tag) => tag.trim().toLowerCase()))];
  if (tags.some((tag) => !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(tag)))
    throw new ApiError(400, "Tags must contain 1–32 letters, numbers, hyphens or underscores");
  return { title, body, tags };
}

async function recordRevision(client, decision, userId, note = null) {
  await client.query(
    `INSERT INTO decision_revisions
       (decision_id, version, title, body, tags, status, changed_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [decision.id, decision.version, decision.title, decision.body,
      decision.tags, decision.status, userId, note],
  );
}

async function emitDecisionChange(io, roomId, decisionId) {
  if (!io) return;
  try {
    const { rows } = await query(
      "SELECT user_id FROM room_members WHERE room_id=$1",
      [roomId],
    );
    if (rows.length)
      io.to(rows.map((member) => `user:${member.user_id}`))
        .emit("decision:changed", { decisionId, roomId });
  } catch (error) {
    console.error("Could not publish decision change", error);
  }
}

async function notifyDecisionMembers(io, decision, actorId) {
  try {
    const { rows } = await query(
      `INSERT INTO notifications (recipient_id,type,reference_id,actor_id,dedupe_key)
       SELECT rm.user_id,'decision',$1::uuid,$2::uuid,
         rm.user_id::text || ':decision:' || $1::text || ':' || $3::text
       FROM room_members rm WHERE rm.room_id=$4::uuid AND rm.user_id<>$2::uuid
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id,recipient_id,type,reference_id,actor_id,seen,created_at`,
      [decision.id, actorId, decision.version, decision.room_id],
    );
    const presented = await presentNotifications(rows);
    await Promise.allSettled(rows.map((row, index) =>
      emitNotification(io, row.recipient_id, presented[index])));
  } catch (error) {
    console.error("Decision notification delivery deferred", error);
  }
}

// ---------- promoteToDecision ----------
// Promote a message to a decision, linked to source_message_id + room_id + tags[]
const promoteToDecision = asyncHandler(async (req, res) => {
  const { roomId, sourceMessageId, title, body, tags, clientId } = req.body || {};
  if (!UUID_RE.test(roomId) || sourceMessageId && !UUID_RE.test(sourceMessageId))
    throw new ApiError(400, "Invalid room or source message");
  if (clientId != null && !UUID_RE.test(clientId))
    throw new ApiError(400, "Invalid creation identifier");
  const fields = decisionFields({ title, body, tags: tags || [] });

  if (clientId) {
    const prior = await query(
      `SELECT d.id FROM decisions d JOIN room_members rm ON rm.room_id=d.room_id
         AND rm.user_id=$1 WHERE d.created_by=$1 AND d.client_id=$2 AND d.room_id=$3`,
      [req.user.id, clientId, roomId],
    );
    if (prior.rowCount)
      return ok(res, await getDecisionPayload(prior.rows[0].id, req.user.id), 201);
  }

  // Verify the caller is a member of the room
  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, "You are not a member of this room");
  }

  if (
    (
      await query(
        "SELECT 1 FROM rooms WHERE id=$1 AND encryption_mode='e2ee-v1'",
        [roomId],
      )
    ).rowCount
  )
    throw new ApiError(
      409,
      "Server-readable collaboration is unavailable in encrypted conversations",
    );

  if (sourceMessageId) {
    const source = await query(
      `SELECT 1 FROM messages m
        WHERE m.id=$1 AND m.room_id=$2 AND m.deleted_at IS NULL
          AND message_visible(m.id,$3)`,
      [sourceMessageId, roomId, req.user.id],
    );
    if (!source.rowCount)
      throw new ApiError(400, "Choose a visible message from this conversation");
  }

  // One statement, so the 201 response carries the same joined shape the list
  // and search endpoints return. A bare RETURNING * would hand back eight raw
  // columns with no room_name, room_slug or author_name — the same shape drift
  // fixed for attachments in Bug 6.
  const client = await pool.connect();
  let created;
  let newlyCreated = false;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO decisions (room_id, source_message_id, title, body, tags, created_by, client_id)
       SELECT r.id, $2::uuid, $3, $4, $5, $6, $7::uuid
         FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$6
        WHERE r.id=$1 AND r.encryption_mode <> 'e2ee-v1'
          AND ($2::uuid IS NULL OR EXISTS (
            SELECT 1 FROM messages m WHERE m.id=$2 AND m.room_id=r.id
              AND m.deleted_at IS NULL AND message_visible(m.id,$6)
          ))
       ON CONFLICT (created_by, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [roomId, sourceMessageId || null, fields.title, fields.body,
        fields.tags, req.user.id, clientId || null],
    );
    if (!result.rowCount) {
      if (!clientId)
        throw new ApiError(409, "Conversation or source message changed. Refresh and try again.");
      const previous = await client.query(
        "SELECT * FROM decisions WHERE created_by=$1 AND client_id=$2",
        [req.user.id, clientId],
      );
      if (!previous.rowCount || previous.rows[0].room_id !== roomId)
        throw new ApiError(409, "Conversation or source message changed. Refresh and try again.");
      created = previous.rows[0];
    } else {
      created = result.rows[0];
      newlyCreated = true;
      await recordRevision(client, created, req.user.id);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const decision = await getDecisionPayload(created.id, req.user.id);
  if (newlyCreated) {
    await emitDecisionChange(req.app.get("io"), roomId, created.id);
    await notifyDecisionMembers(req.app.get("io"), decision, req.user.id);
  }
  return ok(res, decision, 201);
});

// ---------- listDecisions ----------
const decisionOverview = asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT COUNT(*) FILTER (WHERE d.status='active')::integer AS active,
       COUNT(*) FILTER (WHERE d.status='retracted')::integer AS retracted,
       COUNT(*) FILTER (WHERE d.status='active' AND EXISTS (
         SELECT 1 FROM tasks t WHERE t.decision_id=d.id AND t.status<>'done'
       ))::integer AS with_open_tasks,
       COUNT(*) FILTER (WHERE d.status='active' AND EXISTS (
         SELECT 1 FROM tasks t WHERE t.decision_id=d.id
       ) AND NOT EXISTS (
         SELECT 1 FROM tasks t WHERE t.decision_id=d.id AND t.status<>'done'
       ))::integer AS follow_ups_done
     FROM decisions d JOIN room_members rm ON rm.room_id=d.room_id AND rm.user_id=$1`,
    [req.user.id],
  );
  return ok(res, result.rows[0]);
});

// Cross-room: list all decisions across rooms the user is in.
// Optional ?roomId filter for single-room view, ?before=<ISO> to page back.
const listDecisions = asyncHandler(async (req, res) => {
  const { roomId, before } = req.query;
  const pinnedOnly = req.query.pinned === "true";
  const status = req.query.status || "all";
  if (!["all", "active", "retracted"].includes(status))
    throw new ApiError(400, "Invalid decision status");
  if (roomId && !UUID_RE.test(roomId))
    throw new ApiError(400, "Invalid conversation");

  // $1 is always the viewer for capability calculation and cross-room access.
  const params = [req.user.id];
  let scope;

  if (roomId) {
    // Single-room mode: verify membership
    const membership = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, req.user.id],
    );
    if (membership.rows.length === 0) {
      throw new ApiError(403, "You are not a member of this room");
    }
    params.push(roomId);
    scope = `d.room_id = $2`;
  } else {
    scope = `d.room_id IN (SELECT room_id FROM room_members WHERE user_id = $1)`;
  }

  if (pinnedOnly) {
    params.push(req.user.id);
    scope += ` AND EXISTS (
      SELECT 1 FROM decision_pins dp WHERE dp.decision_id=d.id
        AND (dp.scope='room' OR (dp.scope='user' AND dp.user_id=$${params.length}))
    )`;
  }
  if (status !== "all") {
    params.push(status);
    scope += ` AND d.status=$${params.length}`;
  }

  if (before) {
    // Compound cursor "<created_at>|<id>". A bare created_at comparison skips
    // rows when two decisions share a timestamp, because `created_at < cursor`
    // drops every row equal to the cursor — including ones already returned.
    // The id breaks the tie, and the ORDER BY below matches the comparison so
    // the walk is stable. A cursor without the separator is still accepted, so
    // this stays backward compatible with clients holding an older one.
    if (typeof before !== "string") throw new ApiError(400, "Invalid decision cursor");
    const sep = before.indexOf("|");
    const date = sep === -1 ? before : before.slice(0, sep);
    if (!Number.isFinite(Date.parse(date)) || (sep !== -1 && !UUID_RE.test(before.slice(sep + 1))))
      throw new ApiError(400, "Invalid decision cursor");
    if (sep === -1) {
      params.push(before);
      scope += ` AND d.created_at < $${params.length}`;
    } else {
      params.push(before.slice(0, sep), before.slice(sep + 1));
      scope += ` AND (d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
  }

  params.push(PAGE_SIZE);
  const result = await query(
    `SELECT d.*, r.name AS room_name, r.slug AS room_slug, u.display_name AS author_name,
            (SELECT role FROM room_members WHERE room_id=d.room_id AND user_id=$1::uuid) AS viewer_role
     FROM decisions d
     INNER JOIN rooms r ON r.id = d.room_id
     INNER JOIN users u ON u.id = d.created_by
     WHERE ${scope}
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $${params.length}`,
    params,
  );

  // Cursor so older decisions stay reachable; a bare LIMIT 50 stranded them.
  // Only returned on a full page, so a short final page ends the walk.
  const decisions = await attachPins(result.rows, req.user.id);
  let nextCursor = null;
  if (decisions.length === PAGE_SIZE) {
    const last = decisions[decisions.length - 1];
    nextCursor = `${new Date(last.created_at).toISOString()}|${last.id}`;
  }

  return ok(res, { decisions, nextCursor });
});

// ---------- searchDecisions ----------
// Full-text search across decisions (title, body, tags). Serves both the
// room-scoped route and the cross-room one, since the Decisions page is
// top-level and needs to search every room the caller is in.
//
// This tsvector must stay identical to the one in
// 007_decisions_search_includes_tags.sql or the GIN index is not used. It
// covers title + body only: array_to_string is STABLE rather than IMMUTABLE,
// so tags cannot be folded into an index expression and are matched separately
// below. That means a tag-only hit matches but does not contribute to rank —
// see the migration for the upgrade path.
const DECISIONS_TSVECTOR = `to_tsvector('english', d.title || ' ' || d.body)`;

// Escape LIKE/ILIKE wildcards in the caller's term. Without this, searching for
// "50%" or "a_b" matches far more than intended. Backslash is escaped first so
// the escapes added afterwards are not themselves re-escaped. `_` is included
// because it is a single-character wildcard, not just `%`.
const ILIKE_ESCAPED_TERM = `replace(replace(replace($TERM, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

const searchDecisions = asyncHandler(async (req, res) => {
  const { q } = req.query;
  // Present on the room-scoped route, absent on the cross-room one.
  const { roomId } = req.params;
  const filteredRoomId = roomId || req.query.roomId;

  if (typeof q !== "string" || !q.trim() || q.length > 200) {
    throw new ApiError(400, "Search query (q) is required");
  }

  // Same parameter-numbering rule as listDecisions above: $1 is the room or
  // the caller, never an unreferenced placeholder.
  let params;
  let scope;

  if (filteredRoomId) {
    if (!UUID_RE.test(filteredRoomId))
      throw new ApiError(400, "Invalid conversation");
    const membership = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [filteredRoomId, req.user.id],
    );
    if (membership.rows.length === 0) {
      throw new ApiError(403, "You are not a member of this room");
    }
    params = [filteredRoomId];
    scope = `d.room_id = $1`;
  } else {
    params = [req.user.id];
    scope = `d.room_id IN (SELECT room_id FROM room_members WHERE user_id = $1)`;
  }

  params.push(q.trim());
  const termParam = `$${params.length}`;
  params.push(req.user.id);
  const viewerParam = `$${params.length}`;
  const status = req.query.status || "all";
  if (!["all", "active", "retracted"].includes(status))
    throw new ApiError(400, "Invalid decision status");
  const statusSql = status === "all" ? "" : ` AND d.status=$${params.push(status)}`;
  let cursorSql = "";
  if (req.query.after) {
    let cursor;
    try {
      cursor = JSON.parse(Buffer.from(req.query.after, "base64url").toString("utf8"));
    } catch {
      throw new ApiError(400, "Invalid decision search cursor");
    }
    if (!Number.isFinite(cursor?.rank) || !Number.isFinite(Date.parse(cursor?.created_at)) || !UUID_RE.test(cursor?.id))
      throw new ApiError(400, "Invalid decision search cursor");
    params.push(cursor.rank, cursor.created_at, cursor.id);
    cursorSql = ` WHERE (rank, created_at, id) < ($${params.length - 2}::real, $${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(PAGE_SIZE + 1);
  const result = await query(
    `WITH ranked AS (
     SELECT d.*, r.name AS room_name, r.slug AS room_slug, u.display_name AS author_name,
       (SELECT role FROM room_members WHERE room_id=d.room_id AND user_id=${viewerParam}::uuid) AS viewer_role,
       ts_rank(${DECISIONS_TSVECTOR}, plainto_tsquery('english', ${termParam})) AS rank
     FROM decisions d
     INNER JOIN rooms r ON r.id = d.room_id
     INNER JOIN users u ON u.id = d.created_by
     WHERE ${scope}${statusSql}
       AND (
         ${DECISIONS_TSVECTOR} @@ plainto_tsquery('english', ${termParam})
         OR d.tags @> ARRAY[lower(${termParam})]::text[]
         OR EXISTS (
           SELECT 1 FROM unnest(d.tags) AS tag
           -- ESCAPE must be stated, not inherited. Postgres happens to default
           -- to backslash, but the term above is only correct under that exact
           -- setting; stating it makes the escaping independent of the
           -- database's standard_conforming_strings configuration.
           WHERE tag ILIKE '%' || ${ILIKE_ESCAPED_TERM.replace("$TERM", termParam)} || '%' ESCAPE '\\'
         )
       )
    ) SELECT * FROM ranked${cursorSql}
     ORDER BY rank DESC, created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );

  const pageRows = result.rows.slice(0, PAGE_SIZE);
  const last = pageRows[pageRows.length - 1];

  return ok(res, {
    decisions: await attachPins(pageRows, req.user.id),
    query: q.trim(),
    nextCursor: result.rows.length > PAGE_SIZE
      ? Buffer.from(JSON.stringify({ rank: last.rank, created_at: last.created_at, id: last.id })).toString("base64url")
      : null,
  });
});

// ---------- getDecision ----------
// GET /decisions/:decisionId
//
// One decision, in the same joined shape the list and search endpoints return,
// pins attached. Exists so the pinned strip under a room header can resolve to
// the decision itself rather than to the board and leave the reader hunting.
//
// Membership is checked here rather than trusted to getDecisionPayload: that
// service is shared with the pin path, where the caller has already been
// authorised against the room, and adding a check inside it would cost an extra
// query on every pin. Here there is no prior check, so it is this handler's job.
const getDecision = asyncHandler(async (req, res) => {
  const { decisionId } = req.params;

  const membership = await query(
    `SELECT 1 FROM room_members
      WHERE room_id = (SELECT room_id FROM decisions WHERE id = $1)
        AND user_id = $2`,
    [decisionId, req.user.id],
  );
  // An unknown decision and one in a room you are not in are both a 403: the
  // membership subquery returns no row either way, and distinguishing them
  // would confirm a UUID exists to someone who cannot see it.
  if (membership.rows.length === 0) {
    throw new ApiError(403, "You are not a member of this room");
  }

  const decision = await getDecisionPayload(decisionId, req.user.id);
  return ok(res, decision);
});

async function changeDecision(req, retract) {
  const { decisionId } = req.params;
  const expectedVersion = Number(req.body?.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    throw new ApiError(400, "Refresh the decision before changing it");
  const fields = retract ? null : decisionFields(req.body || {});
  const reason = retract ? String(req.body?.reason || "").trim() : null;
  if (retract && (reason.length < 5 || reason.length > 500))
    throw new ApiError(400, "Give a brief reason for retracting this decision");

  const client = await pool.connect();
  let updated;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT d.*, rm.role AS my_role
         FROM decisions d
         JOIN room_members rm ON rm.room_id=d.room_id AND rm.user_id=$2
        WHERE d.id=$1 FOR UPDATE OF d`,
      [decisionId, req.user.id],
    );
    const existing = rows[0];
    if (!existing) throw new ApiError(403, "Decision unavailable");
    if (existing.created_by !== req.user.id && existing.my_role !== "admin")
      throw new ApiError(403, "Only the author or a room admin can change this decision");
    if (existing.status === "retracted")
      throw new ApiError(409, "This decision has been retracted");
    if (existing.version !== expectedVersion)
      throw new ApiError(409, "This decision changed. Refresh before saving your changes");
    const result = await client.query(
      retract
        ? `UPDATE decisions SET status='retracted', updated_at=NOW(), version=version+1
             WHERE id=$1 RETURNING *`
        : `UPDATE decisions SET title=$2, body=$3, tags=$4,
             updated_at=NOW(), version=version+1 WHERE id=$1 RETURNING *`,
      retract
        ? [decisionId]
        : [decisionId, fields.title, fields.body, fields.tags],
    );
    updated = result.rows[0];
    await recordRevision(client, updated, req.user.id, reason);
    if (retract)
      await client.query(
        "DELETE FROM decision_pins WHERE decision_id=$1 AND scope='room'",
        [decisionId],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const decision = await getDecisionPayload(updated.id, req.user.id);
  await emitDecisionChange(req.app.get("io"), updated.room_id, updated.id);
  await notifyDecisionMembers(req.app.get("io"), decision, req.user.id);
  return decision;
}

const editDecision = asyncHandler(async (req, res) =>
  ok(res, await changeDecision(req, false)));

const retractDecision = asyncHandler(async (req, res) =>
  ok(res, await changeDecision(req, true)));

const decisionHistory = asyncHandler(async (req, res) => {
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (before !== null && (!Number.isInteger(before) || before < 1))
    throw new ApiError(400, "Invalid revision cursor");
  const access = await query(
    `SELECT 1 FROM decisions d JOIN room_members rm ON rm.room_id=d.room_id
      WHERE d.id=$1 AND rm.user_id=$2`,
    [req.params.decisionId, req.user.id],
  );
  if (!access.rowCount) throw new ApiError(403, "Decision unavailable");
  const { rows } = await query(
    `SELECT dr.version, dr.title, dr.body, dr.tags, dr.status,
            dr.note, dr.changed_at, u.display_name AS changed_by_name
       FROM decision_revisions dr
       JOIN decisions d ON d.id=dr.decision_id
       JOIN room_members rm ON rm.room_id=d.room_id AND rm.user_id=$2
       JOIN users u ON u.id=dr.changed_by
      WHERE dr.decision_id=$1 AND ($3::int IS NULL OR dr.version < $3)
      ORDER BY dr.version DESC LIMIT 21`,
    [req.params.decisionId, req.user.id, before],
  );
  const revisions = rows.slice(0, 20);
  return ok(res, {
    revisions,
    nextCursor: rows.length > 20 ? revisions[revisions.length - 1].version : null,
  });
});

// ---------- pinDecisionHandler ----------
// PUT /decisions/:decisionId/pin { scope }
//
// Any room member may pin, in either scope. The distinction is not privilege
// but blast radius: a 'user' pin changes nothing for anyone else, a 'room' pin
// changes what every member sees.
const pinDecisionHandler = asyncHandler(async (req, res) => {
  const { decisionId } = req.params;
  const scope = (req.body || {}).scope;

  const decision = await pinDecision({
    decisionId,
    userId: req.user.id,
    scope,
    io: req.app.get("io"),
  });

  return ok(res, decision);
});

// ---------- unpinDecisionHandler ----------
// DELETE /decisions/:decisionId/pin/:scope
//
// A personal pin has one owner. A room pin may be removed by its author or by
// a room admin, so a pin stranded by a member who left does not stick forever.
const unpinDecisionHandler = asyncHandler(async (req, res) => {
  const { decisionId, scope } = req.params;

  const decision = await unpinDecision({
    decisionId,
    userId: req.user.id,
    scope,
    io: req.app.get("io"),
  });

  // Removing an absent pin succeeds with no pin to report, matching
  // removeReaction — a 404 would turn a retried request into a visible failure.
  return ok(res, decision || { decisionId, scope, unpinned: false });
});

module.exports = {
  decisionOverview,
  promoteToDecision,
  listDecisions,
  searchDecisions,
  getDecision,
  editDecision,
  retractDecision,
  decisionHistory,
  pinDecision: pinDecisionHandler,
  unpinDecision: unpinDecisionHandler,
};
