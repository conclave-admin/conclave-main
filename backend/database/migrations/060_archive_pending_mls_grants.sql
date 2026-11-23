-- Archiving invalidates unactivated admissions permanently, even after restore.
-- Serialize on the same room rows as MLS publication and membership changes.
CREATE FUNCTION encryption_v2_archive_pending_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE rid UUID;
BEGIN
 IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
  FOR rid IN SELECT id FROM rooms WHERE team_id=NEW.id AND encryption_mode='e2ee-v2' ORDER BY id FOR UPDATE LOOP
   IF EXISTS(SELECT 1 FROM encryption_v2_device_grants WHERE room_id=rid AND state='pending') THEN
    UPDATE encryption_v2_device_grants SET state='revoked' WHERE room_id=rid AND state='pending';
    UPDATE encryption_v2_mls_rooms SET roster_generation=roster_generation+1,removal_pending=TRUE WHERE room_id=rid;
   END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER encryption_v2_archive_pending_admissions
 AFTER UPDATE OF archived_at ON teams FOR EACH ROW
 EXECUTE FUNCTION encryption_v2_archive_pending_grants();
