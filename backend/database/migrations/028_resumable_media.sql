CREATE TABLE media_upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  upload_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  metadata JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','completed','cancelled','expired','rejected')),
  cleanup_queued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 day',
  UNIQUE (uploader_id, client_id)
);
CREATE INDEX media_upload_sessions_expiry ON media_upload_sessions(expires_at) WHERE status = 'uploading';

CREATE TABLE storage_deletion_jobs (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('r2','cloudinary')),
  object_key TEXT NOT NULL,
  upload_id TEXT NOT NULL DEFAULT '',
  resource_type TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, object_key, upload_id)
);
CREATE INDEX storage_deletion_jobs_due ON storage_deletion_jobs(next_attempt_at);
ALTER TABLE file_uploads ADD COLUMN retired_at TIMESTAMPTZ;

-- The tombstone and its deletion jobs commit together, including REST and socket deletes.
CREATE FUNCTION queue_deleted_message_media() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    INSERT INTO storage_deletion_jobs(provider, object_key, resource_type)
      SELECT CASE WHEN resource_type = 'r2' THEN 'r2' ELSE 'cloudinary' END, public_id, COALESCE(resource_type, 'image')
      FROM attachments WHERE message_id = NEW.id AND public_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    UPDATE file_uploads SET retired_at = NOW() WHERE attached_message_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deleted_message_media AFTER UPDATE OF deleted_at ON messages
  FOR EACH ROW EXECUTE FUNCTION queue_deleted_message_media();

CREATE FUNCTION validate_active_r2_avatar() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE upload_row file_uploads%ROWTYPE;
BEGIN
  IF NEW.avatar_url IS DISTINCT FROM OLD.avatar_url AND NEW.avatar_url LIKE 'r2://%' THEN
    SELECT * INTO upload_row FROM file_uploads WHERE file_url = NEW.avatar_url FOR UPDATE;
    IF NOT FOUND OR upload_row.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'Avatar upload is no longer available' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_active_avatar BEFORE UPDATE OF avatar_url ON users FOR EACH ROW EXECUTE FUNCTION validate_active_r2_avatar();
CREATE TRIGGER rooms_active_avatar BEFORE UPDATE OF avatar_url ON rooms FOR EACH ROW EXECUTE FUNCTION validate_active_r2_avatar();
