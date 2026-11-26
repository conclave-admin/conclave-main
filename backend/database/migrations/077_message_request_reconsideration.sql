ALTER TABLE dm_requests
  ADD COLUMN declined_at TIMESTAMPTZ;

UPDATE dm_requests
SET declined_at = updated_at
WHERE status = 'declined' AND declined_at IS NULL;

CREATE INDEX dm_requests_recipient_history
  ON dm_requests(recipient_id, status, updated_at DESC);
