const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const ApiError = require('../utils/ApiError');

// The Decisions Layer — promote any message to a tagged, searchable
// Decision stored outside the chat timeline. This is one of the three
// differentiator features from the PKB (see docs/).

const PAGE_SIZE = 50;

// ---------- promoteToDecision ----------
// Promote a message to a decision, linked to source_message_id + room_id + tags[]
const promoteToDecision = asyncHandler(async (req, res) => {
  const { roomId, sourceMessageId, title, body, tags } = req.body;

  if (!roomId || !title || !body) {
    throw new ApiError(400, 'roomId, title, and body are required');
  }

  // Verify the caller is a member of the room
  const membership = await query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, req.user.id],
  );
  if (membership.rows.length === 0) {
    throw new ApiError(403, 'You are not a member of this room');
  }

  // One statement, so the 201 response carries the same joined shape the list
  // and search endpoints return. A bare RETURNING * would hand back eight raw
  // columns with no room_name, room_slug or author_name — the same shape drift
  // fixed for attachments in Bug 6.
  const result = await query(
    `WITH inserted AS (
       INSERT INTO decisions (room_id, source_message_id, title, body, tags, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *
     )
     SELECT d.*,
            r.name AS room_name,
            r.slug AS room_slug,
            u.display_name AS author_name
     FROM inserted d
     INNER JOIN rooms r ON r.id = d.room_id
     INNER JOIN users u ON u.id = d.created_by`,
    [roomId, sourceMessageId || null, title, body, tags || [], req.user.id],
  );

  return ok(res, result.rows[0], 201);
});

// ---------- listDecisions ----------
// Cross-room: list all decisions across rooms the user is in.
// Optional ?roomId filter for single-room view, ?before=<ISO> to page back.
const listDecisions = asyncHandler(async (req, res) => {
  const { roomId, before } = req.query;

  const params = [req.user.id];
  let scope;

  if (roomId) {
    // Single-room mode: verify membership
    const membership = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, req.user.id],
    );
    if (membership.rows.length === 0) {
      throw new ApiError(403, 'You are not a member of this room');
    }
    params.push(roomId);
    scope = `d.room_id = $${params.length}`;
  } else {
    scope = `d.room_id IN (SELECT room_id FROM room_members WHERE user_id = $1)`;
  }

  if (before) {
    // Compound cursor "<created_at>|<id>". A bare created_at comparison skips
    // rows when two decisions share a timestamp, because `created_at < cursor`
    // drops every row equal to the cursor — including ones already returned.
    // The id breaks the tie, and the ORDER BY below matches the comparison so
    // the walk is stable. A cursor without the separator is still accepted, so
    // this stays backward compatible with clients holding an older one.
    const sep = before.indexOf('|');
    if (sep === -1) {
      params.push(before);
      scope += ` AND d.created_at < $${params.length}`;
    } else {
      params.push(before.slice(0, sep), before.slice(sep + 1));
      scope +=
        ` AND (d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
  }

  params.push(PAGE_SIZE);
  const result = await query(
    `SELECT d.*, r.name AS room_name, r.slug AS room_slug, u.display_name AS author_name
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
  const decisions = result.rows;
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

  if (!q || !q.trim()) {
    throw new ApiError(400, 'Search query (q) is required');
  }

  const params = [req.user.id];
  let scope;

  if (roomId) {
    const membership = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [roomId, req.user.id],
    );
    if (membership.rows.length === 0) {
      throw new ApiError(403, 'You are not a member of this room');
    }
    params.push(roomId);
    scope = `d.room_id = $${params.length}`;
  } else {
    scope = `d.room_id IN (SELECT room_id FROM room_members WHERE user_id = $1)`;
  }

  params.push(q.trim());
  const termParam = `$${params.length}`;
  const result = await query(
    `SELECT d.*, r.name AS room_name, r.slug AS room_slug, u.display_name AS author_name,
       ts_rank(${DECISIONS_TSVECTOR}, plainto_tsquery('english', ${termParam})) AS rank
     FROM decisions d
     INNER JOIN rooms r ON r.id = d.room_id
     INNER JOIN users u ON u.id = d.created_by
     WHERE ${scope}
       AND (
         ${DECISIONS_TSVECTOR} @@ plainto_tsquery('english', ${termParam})
         OR d.tags @> ARRAY[lower(${termParam})]::text[]
         OR EXISTS (
           SELECT 1 FROM unnest(d.tags) AS tag
           -- ESCAPE must be stated, not inherited. Postgres happens to default
           -- to backslash, but the term above is only correct under that exact
           -- setting; stating it makes the escaping independent of the
           -- database's standard_conforming_strings configuration.
           WHERE tag ILIKE '%' || ${ILIKE_ESCAPED_TERM.replace('$TERM', termParam)} || '%' ESCAPE '\\'
         )
       )
     ORDER BY rank DESC, d.created_at DESC
     LIMIT 50`,
    params,
  );

  return ok(res, { decisions: result.rows, query: q.trim() });
});

module.exports = { promoteToDecision, listDecisions, searchDecisions };
