-- Fix Bug 5 of BACKEND_TASKS.md's audit: searchDecisions claimed to search
-- "title, body, tags" but only title and body were indexed, so a tag match
-- returned nothing.
--
-- Attempt 1 of this migration tried to fold tags into the tsvector:
--
--   to_tsvector('english', title || ' ' || body || ' ' || array_to_string(tags, ' '))
--
-- That fails at CREATE INDEX: "functions in index expression must be marked
-- IMMUTABLE". array_to_string is STABLE, not IMMUTABLE (verified against
-- pg_proc.provolatile), because it depends on the element type's output
-- function. array_to_string(anyarray, text) has no immutable variant.
--
-- So tags are matched outside the tsvector instead:
--   - idx_decisions_search stays on title + body, which is indexable, and
--     carries the ranking.
--   - tags are matched by array containment plus a case-insensitive substring
--     scan over unnest, backed by idx_decisions_tags for the containment half.
--
-- Tradeoff: a hit on a tag alone ranks no better than an unrelated decision
-- that happens to sort by date. If tag relevance ever matters, replace this
-- with a trigger-maintained search_vector tsvector column and a GIN index on
-- it — a column, not an expression, sidesteps the immutability rule but has
-- to be kept in sync.

CREATE INDEX IF NOT EXISTS idx_decisions_search
  ON decisions USING GIN (to_tsvector('english', title || ' ' || body));

-- Backs the `tags @> ARRAY[...]` containment branch.
CREATE INDEX IF NOT EXISTS idx_decisions_tags
  ON decisions USING GIN (tags);
