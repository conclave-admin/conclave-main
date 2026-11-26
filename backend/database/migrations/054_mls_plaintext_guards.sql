-- Disable legacy plaintext write paths in MLS rooms. V1 is preserved elsewhere.
CREATE FUNCTION encryption_v2_reject_plaintext() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM rooms WHERE id=NEW.room_id AND encryption_mode='e2ee-v2')
 THEN RAISE EXCEPTION 'Unavailable in encrypted rooms' USING ERRCODE='P2E01'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER encryption_v2_messages_plaintext BEFORE INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION encryption_v2_reject_plaintext();
CREATE TRIGGER encryption_v2_tasks_plaintext BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION encryption_v2_reject_plaintext();
CREATE TRIGGER encryption_v2_decisions_plaintext BEFORE INSERT OR UPDATE ON decisions FOR EACH ROW EXECUTE FUNCTION encryption_v2_reject_plaintext();
CREATE TRIGGER encryption_v2_digests_plaintext BEFORE INSERT OR UPDATE ON digests FOR EACH ROW EXECUTE FUNCTION encryption_v2_reject_plaintext();
CREATE TRIGGER encryption_v2_briefs_plaintext BEFORE INSERT OR UPDATE ON room_briefs FOR EACH ROW EXECUTE FUNCTION encryption_v2_reject_plaintext();
CREATE TRIGGER encryption_v2_brief_revisions_plaintext BEFORE INSERT OR UPDATE ON room_brief_revisions FOR EACH ROW EXECUTE FUNCTION encryption_v2_reject_plaintext();
CREATE TRIGGER encryption_v2_project_links_plaintext BEFORE INSERT OR UPDATE ON project_rooms FOR EACH ROW EXECUTE FUNCTION encryption_v2_reject_plaintext();
-- A mode toggle must never make existing plaintext rows appear encrypted.
CREATE FUNCTION encryption_v2_protect_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.encryption_mode IS DISTINCT FROM NEW.encryption_mode AND
   (OLD.encryption_mode='e2ee-v2' OR NEW.encryption_mode='e2ee-v2')
 THEN RAISE EXCEPTION 'Encrypted room mode conversion is unavailable' USING ERRCODE='P2E01'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER encryption_v2_mode_guard BEFORE UPDATE OF encryption_mode ON rooms
 FOR EACH ROW EXECUTE FUNCTION encryption_v2_protect_mode();
