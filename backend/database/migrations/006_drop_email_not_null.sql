-- Fix Bug 1 (BACKEND_TASKS.md): deleteMe sets users.email = NULL to anonymise
-- the account, but 001_init.sql declares email as TEXT UNIQUE NOT NULL, so the
-- UPDATE violates the constraint and the whole soft-delete transaction rolls
-- back with a 500.
--
-- Dropping NOT NULL is sufficient: Postgres allows any number of NULLs under a
-- UNIQUE constraint, so live accounts remain uniquely keyed and a deleted
-- account no longer occupies its email. See also 005_add_user_deleted_at.sql.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
