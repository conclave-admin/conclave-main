-- Shared request limits remain enforced when the optional Redis service is
-- missing or temporarily unavailable. API instances coordinate through the
-- primary PostgreSQL database with atomic fixed-window upserts.
CREATE TABLE IF NOT EXISTS request_rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  reset_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_rate_limit_buckets_reset
  ON request_rate_limit_buckets(reset_at);
