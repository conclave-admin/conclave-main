-- Fix Bug 3 of BACKEND_TASKS.md's audit: searchDecisions claims to search
-- "title, body, tags" but the index and query only covered title + body, so
-- tags were silently ignored.
--
-- Recreate the GIN index over title, body AND tags. array_to_string is
-- IMMUTABLE and to_tsvector(regconfig, text) is IMMUTABLE for a constant
-- config, so this stays a valid index expression.
--
-- Queries must use this exact expression or they will not use the index.
-- See decisions.controller.js.

DROP INDEX IF EXISTS idx_decisions_search;

CREATE INDEX idx_decisions_search
  ON decisions USING GIN (
    to_tsvector(
      'english',
      title || ' ' || body || ' ' || COALESCE(array_to_string(tags, ' '), '')
    )
  );
