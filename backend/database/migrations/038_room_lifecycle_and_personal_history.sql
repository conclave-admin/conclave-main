ALTER TABLE rooms ADD COLUMN join_approval BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rooms ADD COLUMN member_can_send BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE rooms ADD COLUMN member_can_invite BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE room_members ADD COLUMN cleared_sequence BIGINT NOT NULL DEFAULT 0 CHECK(cleared_sequence>=0);
ALTER TABLE room_members ADD COLUMN cleared_at TIMESTAMPTZ;
CREATE TABLE room_invites (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, created_by UUID NOT NULL REFERENCES users(id),
 expires_at TIMESTAMPTZ NOT NULL, max_uses INT NOT NULL CHECK(max_uses BETWEEN 1 AND 10000),
 uses INT NOT NULL DEFAULT 0 CHECK(uses>=0), revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX room_invites_room ON room_invites(room_id);
CREATE TABLE room_join_requests (
 room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 invite_id UUID REFERENCES room_invites(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 reviewed_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(room_id,user_id)
);
CREATE FUNCTION message_visible(mid UUID,viewer UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM messages m JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=viewer
 WHERE m.id=mid AND (m.room_sequence>rm.cleared_sequence OR (m.room_sequence IS NULL AND rm.cleared_at IS NULL)));
$$;
CREATE FUNCTION sync_room_personal_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO sync_changes(kind,operation,entity_id,room_id,user_id,private)
 VALUES('preferences','UPDATE',NEW.user_id,NEW.room_id,NEW.user_id,TRUE);
 RETURN NULL;
END; $$;
CREATE TRIGGER sync_personal_history AFTER UPDATE OF cleared_sequence ON room_members FOR EACH ROW
 WHEN(OLD.cleared_sequence IS DISTINCT FROM NEW.cleared_sequence) EXECUTE FUNCTION sync_room_personal_history();
CREATE FUNCTION sync_room_management() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO sync_changes(kind,operation,entity_id,room_id) VALUES('room',TG_OP,NEW.room_id,NEW.room_id);
 IF TG_TABLE_NAME='room_join_requests' THEN
 INSERT INTO sync_changes(kind,operation,entity_id,room_id,user_id,private) VALUES('room',TG_OP,NEW.room_id,NEW.room_id,NEW.user_id,TRUE);
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER sync_room_invites AFTER INSERT OR UPDATE ON room_invites FOR EACH ROW EXECUTE FUNCTION sync_room_management();
CREATE TRIGGER sync_room_join_requests AFTER INSERT OR UPDATE ON room_join_requests FOR EACH ROW EXECUTE FUNCTION sync_room_management();
-- Personal clearing survives leaving and later rejoining a room.
CREATE TABLE room_personal_history (
 room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 cleared_sequence BIGINT NOT NULL DEFAULT 0,cleared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(room_id,user_id)
);
CREATE FUNCTION restore_personal_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT COALESCE((SELECT cleared_sequence FROM room_personal_history WHERE room_id=NEW.room_id AND user_id=NEW.user_id),0) INTO NEW.cleared_sequence;
 SELECT (SELECT cleared_at FROM room_personal_history WHERE room_id=NEW.room_id AND user_id=NEW.user_id) INTO NEW.cleared_at;
 RETURN NEW;
END; $$;
CREATE TRIGGER restore_personal_history BEFORE INSERT ON room_members FOR EACH ROW EXECUTE FUNCTION restore_personal_history();
CREATE TRIGGER sync_personal_history_preferences AFTER INSERT OR UPDATE ON room_personal_history FOR EACH ROW EXECUTE FUNCTION record_sync_change('preferences');
