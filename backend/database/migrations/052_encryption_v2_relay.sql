-- Experimental ciphertext relay. No room is switched to v2 by this migration.
-- Key-package authenticity and protocol state remain client responsibilities.
ALTER TABLE rooms DROP CONSTRAINT rooms_encryption_mode_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_encryption_mode_check
  CHECK (encryption_mode IN ('none', 'e2ee-v1', 'e2ee-v2'));
CREATE TABLE encryption_v2_key_packages (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL CHECK (protocol IN ('signal', 'mls')),
  payload BYTEA NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX encryption_v2_key_packages_available
  ON encryption_v2_key_packages(user_id, protocol, created_at)
  WHERE consumed_at IS NULL;

CREATE TABLE encryption_v2_room_state (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL CHECK (protocol IN ('signal', 'mls')),
  epoch BIGINT NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

CREATE TABLE encryption_v2_room_events (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL CHECK (protocol IN ('signal', 'mls')),
  kind TEXT NOT NULL CHECK (kind IN ('ciphertext', 'commit', 'welcome')),
  epoch BIGINT NOT NULL CHECK (epoch >= 0),
  payload BYTEA NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 1048576),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  UNIQUE(room_id, sequence)
);
CREATE INDEX encryption_v2_room_events_page
  ON encryption_v2_room_events(room_id, sequence);

-- The grant records the relay sequence visible when a person entered. New
-- members cannot fetch earlier envelopes even if their room role changes.
CREATE TABLE encryption_v2_room_grants (
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_sequence BIGINT NOT NULL CHECK (start_sequence >= 0),
  PRIMARY KEY (room_id, user_id)
);

CREATE FUNCTION encryption_v2_sync_room_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_sequence BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM encryption_v2_room_grants
    WHERE room_id=OLD.room_id AND user_id=OLD.user_id;
    RETURN OLD;
  END IF;
  SELECT last_sequence INTO current_sequence FROM encryption_v2_room_state
  WHERE room_id=NEW.room_id;
  IF current_sequence IS NOT NULL THEN
    INSERT INTO encryption_v2_room_grants(room_id,user_id,start_sequence)
    VALUES(NEW.room_id,NEW.user_id,current_sequence)
    ON CONFLICT(room_id,user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER encryption_v2_room_grant_insert AFTER INSERT ON room_members
  FOR EACH ROW EXECUTE FUNCTION encryption_v2_sync_room_grant();
CREATE TRIGGER encryption_v2_room_grant_delete AFTER DELETE ON room_members
  FOR EACH ROW EXECUTE FUNCTION encryption_v2_sync_room_grant();
