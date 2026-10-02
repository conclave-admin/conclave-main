-- Constrain tasks.status to the three values the UI and digest already assume.
--
-- The column is a bare TEXT and migration 002 only documented the allowed set in
-- a comment, which is not enforcement. Nothing else writes to tasks today, so
-- this lands before the first endpoint rather than after; once POST /tasks and
-- PATCH /tasks/:id/status exist every write path inherits the guarantee instead
-- of each one re-validating.
--
-- The digest reads this column directly (controllers/digest.controller.js), so an
-- unvalidated value would surface to a user as garbage in their catch-up feed.
--
-- Locking: this validated in milliseconds against the development database,
-- which holds no task rows. On a populated production table ALTER TABLE ... ADD
-- CONSTRAINT takes an ACCESS EXCLUSIVE lock and rescans the whole table, so the
-- online variant is:
--
--   ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
--     CHECK (...) NOT VALID;
--   ALTER TABLE tasks VALIDATE CONSTRAINT tasks_status_check;
--
-- NOT VALID skips the scan but still enforces the constraint on new rows, and
-- VALIDATE takes only SHARE UPDATE EXCLUSIVE. Split it that way if this ever
-- runs against real data.

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('open', 'in_progress', 'done'));