-- Remove message end-to-end encryption from the product: both the shipped
-- `conclave-e2ee-v1` rooms and the experimental `e2ee-v2` (MLS) relay.
--
-- Encrypted conversations are purged because the server cannot decrypt them.
-- Account-security encryption, signed media URLs and push are untouched.

-- 1. Encryption triggers must go before any row they guard is touched.
DROP TRIGGER IF EXISTS revoke_session_encryption ON auth_sessions;
DROP TRIGGER IF EXISTS encryption_v2_session_revoked ON auth_sessions;
DROP TRIGGER IF EXISTS encryption_v2_room_grant_insert ON room_members;
DROP TRIGGER IF EXISTS encryption_v2_room_grant_delete ON room_members;
DROP TRIGGER IF EXISTS encryption_v2_membership_serialization ON room_members;
DROP TRIGGER IF EXISTS encryption_v2_messages_plaintext ON messages;
DROP TRIGGER IF EXISTS encryption_v2_tasks_plaintext ON tasks;
DROP TRIGGER IF EXISTS encryption_v2_decisions_plaintext ON decisions;
DROP TRIGGER IF EXISTS encryption_v2_digests_plaintext ON digests;
DROP TRIGGER IF EXISTS encryption_v2_briefs_plaintext ON room_briefs;
DROP TRIGGER IF EXISTS encryption_v2_brief_revisions_plaintext ON room_brief_revisions;
DROP TRIGGER IF EXISTS encryption_v2_project_links_plaintext ON project_rooms;
DROP TRIGGER IF EXISTS encryption_v2_mode_guard ON rooms;
DROP TRIGGER IF EXISTS encryption_v2_archive_pending_admissions ON teams;

-- Preserve unrelated rooms and team data while removing encrypted rooms.
CREATE TEMP TABLE _orphaned_encrypted_teams ON COMMIT DROP AS
  SELECT id FROM teams
  WHERE general_room_id IN (SELECT id FROM rooms WHERE encryption_mode <> 'none');
-- Hard deletes bypass the tombstone trigger; queue objects before cascading.
INSERT INTO storage_deletion_jobs(provider, object_key, resource_type)
 SELECT CASE WHEN a.resource_type = 'r2' THEN 'r2' ELSE 'cloudinary' END,
        a.public_id, COALESCE(a.resource_type, 'image')
 FROM attachments a JOIN messages m ON m.id = a.message_id
 JOIN rooms r ON r.id = m.room_id
 WHERE r.encryption_mode <> 'none' AND a.public_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM attachments other JOIN messages om ON om.id=other.message_id
   JOIN rooms survivor ON survivor.id=om.room_id
   WHERE other.public_id=a.public_id AND other.resource_type IS NOT DISTINCT FROM a.resource_type
     AND survivor.encryption_mode='none')
 ON CONFLICT DO NOTHING;
INSERT INTO storage_deletion_jobs(provider, object_key)
 SELECT 'r2', o.object_key FROM encryption_v2_objects o
 JOIN rooms r ON r.id = o.room_id WHERE r.encryption_mode <> 'none'
 ON CONFLICT DO NOTHING;
INSERT INTO storage_deletion_jobs(provider, object_key, upload_id)
 SELECT 'r2', s.object_key, s.upload_id FROM media_upload_sessions s
 JOIN rooms r ON r.id = s.room_id
 WHERE r.encryption_mode <> 'none' AND s.status = 'uploading'
 ON CONFLICT DO NOTHING;
-- An upload may have completed at the provider despite a lost response.
INSERT INTO storage_deletion_jobs(provider, object_key)
 SELECT 'r2', s.object_key FROM media_upload_sessions s JOIN rooms r ON r.id=s.room_id
 WHERE r.encryption_mode <> 'none' AND s.status='uploading'
 ON CONFLICT DO NOTHING;
INSERT INTO storage_deletion_jobs(provider, object_key)
 SELECT 'r2', s.object_key FROM media_upload_sessions s
 JOIN rooms r ON r.id=s.room_id
 WHERE r.encryption_mode <> 'none' AND s.status='completed'
 AND NOT EXISTS (SELECT 1 FROM attachments a JOIN messages m ON m.id=a.message_id
   JOIN rooms survivor ON survivor.id=m.room_id
   WHERE a.public_id=s.object_key AND a.resource_type='r2' AND survivor.encryption_mode='none')
 ON CONFLICT DO NOTHING;
-- Single-request uploads have no room pointer until attached. Their dedicated
-- MIME type is sufficient to identify abandoned encrypted containers.
INSERT INTO storage_deletion_jobs(provider,object_key,resource_type)
 SELECT CASE WHEN f.resource_type='r2' THEN 'r2' ELSE 'cloudinary' END,
        f.public_id,COALESCE(f.resource_type,'image') FROM file_uploads f
 WHERE f.mime_type='application/vnd.conclave.encrypted' AND f.public_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM attachments a JOIN messages m ON m.id=a.message_id
   JOIN rooms survivor ON survivor.id=m.room_id
   WHERE a.public_id=f.public_id AND a.resource_type IS NOT DISTINCT FROM f.resource_type
     AND survivor.encryption_mode='none')
 ON CONFLICT DO NOTHING;
UPDATE file_uploads SET retired_at = NOW() WHERE attached_message_id IN
 (SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.encryption_mode <> 'none');
UPDATE file_uploads f SET retired_at=NOW() FROM media_upload_sessions s JOIN rooms r ON r.id=s.room_id
 WHERE r.encryption_mode <> 'none' AND s.status='completed' AND f.public_id=s.object_key
 AND f.attached_message_id IS NULL;
UPDATE file_uploads SET retired_at=COALESCE(retired_at,NOW())
 WHERE mime_type='application/vnd.conclave.encrypted';
-- Archived-team guards must not prevent the expressly requested purge.
ALTER TABLE messages DISABLE TRIGGER team_message_change_guard;
ALTER TABLE tasks DISABLE TRIGGER team_task_change_guard;
ALTER TABLE decisions DISABLE TRIGGER team_decision_change_guard;
ALTER TABLE room_members DISABLE TRIGGER team_room_membership_archive_guard;
ALTER TABLE room_members DISABLE TRIGGER team_owner_room_guard;
UPDATE rooms SET superseded_by = NULL
 WHERE superseded_by IN (SELECT id FROM rooms WHERE encryption_mode <> 'none');
UPDATE teams SET general_room_id = NULL WHERE id IN (SELECT id FROM _orphaned_encrypted_teams);
-- Preserve surviving messages even if historical cross-room references exist.
UPDATE messages SET reply_to_id=NULL WHERE reply_to_id IN
  (SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.encryption_mode <> 'none');
UPDATE messages SET thread_root_id=NULL WHERE thread_root_id IN
  (SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.encryption_mode <> 'none');
UPDATE tasks SET source_message_id = NULL WHERE source_message_id IN
  (SELECT m.id FROM messages m JOIN rooms r ON r.id = m.room_id WHERE r.encryption_mode <> 'none');
UPDATE decisions SET source_message_id = NULL WHERE source_message_id IN
  (SELECT m.id FROM messages m JOIN rooms r ON r.id = m.room_id WHERE r.encryption_mode <> 'none');
DELETE FROM rooms WHERE encryption_mode <> 'none';
-- A team with surviving rooms or projects still needs an accessible general
-- room. Create an empty one and restore membership without exposing old history.
CREATE TEMP TABLE _replacement_general ON COMMIT DROP AS
 SELECT t.id AS team_id, t.owner_id, gen_random_uuid() AS room_id
 FROM teams t JOIN _orphaned_encrypted_teams affected ON affected.id=t.id
 WHERE EXISTS (SELECT 1 FROM rooms r WHERE r.team_id=t.id)
    OR EXISTS (SELECT 1 FROM projects p WHERE p.team_id=t.id);
INSERT INTO rooms(id,name,type,created_by,slug,team_id)
 SELECT room_id,'general','group',owner_id,'general-' || room_id::text,team_id FROM _replacement_general;
INSERT INTO room_members(room_id,user_id,role,team_owner_grant,independent_admin)
 SELECT replacement.room_id, member.user_id,
        CASE WHEN member.user_id=replacement.owner_id THEN 'admin' ELSE 'member' END,
        member.user_id=replacement.owner_id,FALSE
 FROM _replacement_general replacement JOIN team_members member ON member.team_id=replacement.team_id;
UPDATE teams t SET general_room_id=replacement.room_id FROM _replacement_general replacement
 WHERE t.id=replacement.team_id;
ALTER TABLE messages ENABLE TRIGGER team_message_change_guard;
ALTER TABLE tasks ENABLE TRIGGER team_task_change_guard;
ALTER TABLE decisions ENABLE TRIGGER team_decision_change_guard;
ALTER TABLE room_members ENABLE TRIGGER team_room_membership_archive_guard;
ALTER TABLE room_members ENABLE TRIGGER team_owner_room_guard;
DELETE FROM teams t WHERE t.id IN (SELECT id FROM _orphaned_encrypted_teams)
  AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.team_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.team_id = t.id);

-- 3. Drop the V2 relay, device-admission and opaque-object tables. Order
--    follows the foreign keys (children before parents).
DROP TABLE IF EXISTS encryption_v2_objects;
DROP TABLE IF EXISTS encryption_v2_device_enrollments;
DROP TABLE IF EXISTS encryption_v2_identity_roots;
DROP TABLE IF EXISTS encryption_v2_device_approvals;
DROP TABLE IF EXISTS encryption_v2_device_revocations;
DROP TABLE IF EXISTS encryption_v2_package_claims;
DROP TABLE IF EXISTS encryption_v2_device_grants;
DROP TABLE IF EXISTS encryption_v2_mls_events;
DROP TABLE IF EXISTS encryption_v2_mls_packages;
DROP TABLE IF EXISTS encryption_v2_mls_rooms;
DROP TABLE IF EXISTS encryption_v2_session_devices;
DROP TABLE IF EXISTS encryption_v2_devices;
DROP TABLE IF EXISTS encryption_v2_room_grants;
DROP TABLE IF EXISTS encryption_v2_room_events;
DROP TABLE IF EXISTS encryption_v2_room_state;
DROP TABLE IF EXISTS encryption_v2_key_packages;

-- 4. Drop the V1 device registry and key backups.
DROP TABLE IF EXISTS encryption_backups;
DROP TABLE IF EXISTS encryption_devices;

-- 5. Drop the trigger functions whose triggers are already gone.
DROP FUNCTION IF EXISTS revoke_encryption_device();
DROP FUNCTION IF EXISTS sync_encryption_device();
DROP FUNCTION IF EXISTS encryption_v2_sync_room_grant();
DROP FUNCTION IF EXISTS encryption_v2_membership_fence();
DROP FUNCTION IF EXISTS encryption_v2_session_revoke();
DROP FUNCTION IF EXISTS encryption_v2_reject_plaintext();
DROP FUNCTION IF EXISTS encryption_v2_protect_mode();
DROP FUNCTION IF EXISTS encryption_v2_archive_pending_grants();

-- 6. Drop encryption columns; room lifecycle still uses superseded_by.
ALTER TABLE auth_sessions DROP CONSTRAINT IF EXISTS auth_sessions_id_user_unique;
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_encryption_mode_check;
ALTER TABLE messages DROP COLUMN IF EXISTS encrypted_payload;
ALTER TABLE users DROP COLUMN IF EXISTS identity_public_key;
ALTER TABLE rooms DROP COLUMN IF EXISTS encryption_mode;
