ALTER TABLE messages ADD COLUMN thread_root_id UUID REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE rooms ADD COLUMN disappearing_seconds INT CHECK(disappearing_seconds IN(86400,604800,7776000));
ALTER TABLE rooms ADD COLUMN personal_for UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE room_member_preferences ADD COLUMN mute_until TIMESTAMPTZ;
ALTER TABLE room_member_preferences ADD COLUMN notification_level TEXT NOT NULL DEFAULT 'all' CHECK(notification_level IN('all','mentions','none'));
ALTER TABLE users ADD COLUMN dnd_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN custom_status TEXT CHECK(length(custom_status)<=100);
ALTER TABLE users ADD COLUMN status_until TIMESTAMPTZ;
CREATE INDEX messages_thread ON messages(thread_root_id,room_sequence) WHERE thread_root_id IS NOT NULL;
CREATE INDEX messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE thread_reads(root_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,last_sequence BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(root_id,user_id));
CREATE TRIGGER sync_thread_reads AFTER INSERT OR UPDATE ON thread_reads FOR EACH ROW EXECUTE FUNCTION record_sync_change('preferences');
CREATE TABLE scheduled_messages (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 client_id UUID NOT NULL, payload JSONB, due_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sending','sent','needs_review','cancelled')),
 reason TEXT, lease_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,client_id)
);
CREATE INDEX scheduled_messages_due ON scheduled_messages(due_at) WHERE status IN('pending','sending');
CREATE TRIGGER sync_schedules AFTER INSERT OR UPDATE ON scheduled_messages FOR EACH ROW EXECUTE FUNCTION record_sync_change('preferences');
CREATE TABLE message_reminders (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 due_at TIMESTAMPTZ NOT NULL,completed_at TIMESTAMPTZ,cancelled_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX message_reminders_due ON message_reminders(due_at) WHERE completed_at IS NULL AND cancelled_at IS NULL;
CREATE TRIGGER sync_reminders AFTER INSERT OR UPDATE ON message_reminders FOR EACH ROW EXECUTE FUNCTION record_sync_change('preferences');
-- Enforce expiry and thread shape for every insertion, including integrations.
CREATE FUNCTION prepare_message_experience() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_room UUID; root_parent UUID; lifetime INT;
BEGIN
 IF NEW.thread_root_id IS NOT NULL THEN
  SELECT room_id,thread_root_id INTO root_room,root_parent FROM messages WHERE id=NEW.thread_root_id AND deleted_at IS NULL;
  IF root_room IS DISTINCT FROM NEW.room_id OR root_parent IS NOT NULL THEN RAISE EXCEPTION 'Invalid thread root' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT disappearing_seconds INTO lifetime FROM rooms WHERE id=NEW.room_id;
 IF lifetime IS NOT NULL THEN NEW.expires_at:=NEW.created_at+make_interval(secs=>lifetime); END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER prepare_message_experience BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION prepare_message_experience();
-- Expired rows are inaccessible even while the asynchronous cleanup is delayed.
CREATE OR REPLACE FUNCTION message_visible(mid UUID,viewer UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM messages m JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=viewer
 WHERE m.id=mid AND (m.expires_at IS NULL OR m.expires_at>NOW())
 AND (m.room_sequence>rm.cleared_sequence OR (m.room_sequence IS NULL AND rm.cleared_at IS NULL)));
$$;
CREATE TABLE room_policy_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,user_id UUID REFERENCES users(id),seconds INT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TRIGGER sync_room_policy_events AFTER INSERT ON room_policy_events FOR EACH ROW EXECUTE FUNCTION sync_room_management();
CREATE FUNCTION protect_personal_room() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner UUID;
BEGIN
 SELECT personal_for INTO owner FROM rooms WHERE id=NEW.room_id;
 IF owner IS NOT NULL AND owner<>NEW.user_id THEN RAISE EXCEPTION 'Personal notes cannot have other members' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_personal_room BEFORE INSERT OR UPDATE ON room_members FOR EACH ROW EXECUTE FUNCTION protect_personal_room();
