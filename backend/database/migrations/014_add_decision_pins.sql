-- Decision pins (phase 5, frontend.md section 6).
--
-- A decision can be pinned in two scopes, and the difference matters:
--
--   scope = 'user'  a personal bookmark. Only its author sees it, only they
--                   remove it. Nothing about the room changes.
--   scope = 'room'  a room-wide pin. Every member sees it in the strip under
--                   the room header. Removing one is a moderation act, so the
--                   author of the pin OR a room admin may do it.
--
-- Both live in one table rather than a `pinned_at` column on `decisions`
-- beside a second `user_decision_pins` table. A room pin is still an action
-- somebody took, and keeping it in a row records who, for free, with the same
-- two routes and the same query shape for both scopes. A bare boolean on
-- `decisions` would have thrown that away and needed a second table to get it
-- back.
--
-- Composite primary key rather than a surrogate id: pinning is idempotent. A
-- second PUT with the same (decision, user, scope) is an UPDATE of pinned_at
-- rather than a duplicate row, so "reacting twice does not stack" holds here
-- too. ON DELETE CASCADE on both keys means deleting a decision or an account
-- leaves no orphaned pins behind for the strip to join against.
--
-- The strip's read ("room pins for one room") is served by the unique index
-- below, since a unique index answers a scan exactly as a non-unique one would.
-- Personal pins are read per (decision, user), which the primary key already
-- covers, so they need no index of their own.
--
-- At most ONE room pin per decision, enforced by that index. "Pinned to the
-- room" is a state the decision is in, not a pile of people who each said
-- so — with several rows the strip would have to pick one to attribute and an
-- admin's unpin could remove a row that is not the one being displayed. The
-- row's user_id is therefore the owner of the room pin, and pinner-or-admin
-- unpinning has exactly one row to delete.
--
-- A second user pinning to the room gets a 409 naming who holds it, rather
-- than silently becoming the new owner.

CREATE TABLE IF NOT EXISTS decision_pins (
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('user', 'room')),
  pinned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (decision_id, user_id, scope)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_pins_one_room_pin
  ON decision_pins (decision_id)
  WHERE scope = 'room';
