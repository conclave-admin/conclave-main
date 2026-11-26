-- Writers append in their own transaction. Cursors are assigned ONLY after
-- commit by a serialized allocator, so late commits cannot fall behind a cursor.
CREATE SEQUENCE sync_cursor_sequence;
CREATE TABLE sync_changes (
  id BIGSERIAL PRIMARY KEY,
  cursor BIGINT UNIQUE,
  kind TEXT NOT NULL,
  operation TEXT NOT NULL,
  entity_id UUID,
  room_id UUID,
  user_id UUID,
  private BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  lease_token UUID
);
CREATE INDEX sync_changes_pending ON sync_changes(next_attempt_at,id) WHERE delivered_at IS NULL;
CREATE INDEX sync_changes_unassigned ON sync_changes(id) WHERE cursor IS NULL;
CREATE TABLE sync_retention (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), floor BIGINT NOT NULL DEFAULT 0);
INSERT INTO sync_retention DEFAULT VALUES;
ALTER TABLE users ADD COLUMN profile_version BIGINT NOT NULL DEFAULT 1;
CREATE FUNCTION increment_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.profile_version:=OLD.profile_version+1; RETURN NEW; END; $$;
CREATE TRIGGER profile_version BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION increment_profile_version();
ALTER TABLE messages ADD COLUMN state_version BIGINT NOT NULL DEFAULT 1;
CREATE FUNCTION increment_message_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.state_version := OLD.state_version + 1; RETURN NEW; END; $$;
CREATE TRIGGER message_state_version BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION increment_message_state();

CREATE FUNCTION record_sync_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d JSONB; rid UUID; uid UUID; eid UUID; mid UUID; k TEXT; own BOOLEAN := FALSE; previous_owner TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN d := to_jsonb(OLD); ELSE d := to_jsonb(NEW); END IF;
  k := TG_ARGV[0]; eid := NULLIF(d->>'id','')::uuid;
  rid := NULLIF(d->>'room_id','')::uuid; uid := NULLIF(d->>'user_id','')::uuid;
  IF TG_TABLE_NAME='rooms' AND TG_OP='UPDATE' AND (d-'message_sequence')=(to_jsonb(OLD)-'message_sequence') THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='room_members' AND TG_OP='UPDATE' AND (to_jsonb(OLD)->>'role')=(d->>'role') AND (to_jsonb(OLD)->>'joined_at')=(d->>'joined_at') THEN RETURN NULL; END IF;
  IF k = 'message_child' THEN
    mid := NULLIF(d->>'message_id','')::uuid;
    IF mid IS NULL THEN SELECT message_id INTO mid FROM polls WHERE id=(d->>'poll_id')::uuid; END IF;
    IF mid IS NOT NULL THEN
      previous_owner := current_setting('conclave.sync_private_user', TRUE);
      IF TG_TABLE_NAME='message_pins' AND d->>'scope'='user' THEN
        PERFORM set_config('conclave.sync_private_user',uid::text,TRUE);
      END IF;
      UPDATE messages SET state_version=state_version WHERE id=mid;
      PERFORM set_config('conclave.sync_private_user',COALESCE(previous_owner,''),TRUE);
    END IF;
    RETURN NULL;
  ELSIF k='message' THEN
    uid := NULLIF(current_setting('conclave.sync_private_user',TRUE),'')::uuid;
    own := uid IS NOT NULL;
  ELSIF k='room' THEN rid := eid;
  ELSIF k='membership' THEN eid := uid;
  ELSIF k='profile' THEN uid := eid;
  ELSIF k='notification' THEN uid := (d->>'recipient_id')::uuid; own := TRUE;
  ELSIF k='preferences' THEN own := TRUE; eid := uid;
  ELSIF k='block' THEN uid := (d->>'blocker_id')::uuid; eid := (d->>'blocked_id')::uuid; own := TRUE;
  END IF;
  INSERT INTO sync_changes(kind,operation,entity_id,room_id,user_id,private)
    VALUES(k,TG_OP,eid,rid,uid,own);
  IF k='block' THEN
    INSERT INTO sync_changes(kind,operation,entity_id,user_id,private)
      VALUES(k,TG_OP,uid,eid,TRUE);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER sync_messages AFTER INSERT OR UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION record_sync_change('message');
CREATE TRIGGER sync_rooms AFTER INSERT OR UPDATE OR DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION record_sync_change('room');
CREATE TRIGGER sync_members AFTER INSERT OR UPDATE OR DELETE ON room_members FOR EACH ROW EXECUTE FUNCTION record_sync_change('membership');
CREATE TRIGGER sync_profiles AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION record_sync_change('profile');
CREATE TRIGGER sync_notifications AFTER INSERT OR UPDATE OR DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION record_sync_change('notification');
CREATE TRIGGER sync_preferences AFTER INSERT OR UPDATE OR DELETE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION record_sync_change('preferences');
CREATE TRIGGER sync_blocks AFTER INSERT OR DELETE ON user_blocks FOR EACH ROW EXECUTE FUNCTION record_sync_change('block');
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['attachments','message_mentions','message_reactions','message_pins','polls','poll_options','poll_votes'] LOOP
    EXECUTE format('CREATE TRIGGER sync_message_child AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION record_sync_change(''message_child'')',t);
  END LOOP;
END; $$;

CREATE TRIGGER sync_room_preferences AFTER INSERT OR UPDATE OR DELETE ON room_member_preferences FOR EACH ROW EXECUTE FUNCTION record_sync_change('preferences');
