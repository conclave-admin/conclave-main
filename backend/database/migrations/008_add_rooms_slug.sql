-- Fix Bug 4 of BACKEND_TASKS.md's audit: Decisions.jsx renders
-- #{decision.room_slug} and rooms had no slug column, so the Decisions page
-- renders #undefined against real data. The dev fixtures carried a room_slug
-- that no endpoint ever returned, which hid this.
--
-- slug is display-only. Rooms are addressed by UUID everywhere
-- (/rooms/:roomId), so this is a handle for the metadata line, not a routing
-- key.
--
-- rooms.name is NOT unique -- the only UNIQUE constraints in 001_init.sql are
-- on roles.name, users.email and message_reactions -- so duplicate names are
-- expected and the backfill disambiguates them. Ordering by (created_at, id)
-- makes the result deterministic: the oldest room keeps the bare slug, later
-- ones get -2, -3, and so on.
--
-- Names that slugify to nothing (non-Latin script, or a name of only symbols)
-- fall back to 'room' and then resolve through the same collision ranking.

ALTER TABLE rooms ADD COLUMN slug TEXT;

WITH slugged AS (
  SELECT
    id,
    created_at,
    COALESCE(
      NULLIF(
        trim(both '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')),
        ''
      ),
      'room'
    ) AS base
  FROM rooms
),
ranked AS (
  SELECT
    id,
    base,
    row_number() OVER (PARTITION BY base ORDER BY created_at, id) AS n
  FROM slugged
)
UPDATE rooms r
   SET slug = CASE
                WHEN ranked.n = 1 THEN ranked.base
                ELSE ranked.base || '-' || ranked.n
              END
  FROM ranked
 WHERE r.id = ranked.id;

-- Anything inserted while the column was nullable, or that somehow missed the
-- backfill, must not survive as NULL.
UPDATE rooms SET slug = 'room-' || id::text WHERE slug IS NULL;

ALTER TABLE rooms ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX idx_rooms_slug ON rooms (slug);
