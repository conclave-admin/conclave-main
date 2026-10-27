-- A retry of the same create intent must return its original decision.
ALTER TABLE decisions ADD COLUMN client_id UUID;
CREATE UNIQUE INDEX decisions_creator_client_id
  ON decisions(created_by, client_id) WHERE client_id IS NOT NULL;

CREATE INDEX decision_revisions_recent
  ON decision_revisions(decision_id, version DESC);
