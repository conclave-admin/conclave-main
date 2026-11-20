-- Object authorization uses a room history boundary, not a clear attachment-
-- to-message/album relationship. Existing unbound objects remain creator-only
-- until explicitly uploaded again; no grant gains older object access.
ALTER TABLE encryption_v2_objects ADD COLUMN sequence_boundary BIGINT NOT NULL DEFAULT 0 CHECK(sequence_boundary>=0);
DROP INDEX encryption_v2_objects_event;
ALTER TABLE encryption_v2_objects DROP COLUMN logical_message_id;
