-- Recover media from messages deleted before durable cleanup was introduced.
INSERT INTO storage_deletion_jobs(provider, object_key, resource_type)
  SELECT DISTINCT CASE WHEN a.resource_type = 'r2' THEN 'r2' ELSE 'cloudinary' END,
    a.public_id, COALESCE(a.resource_type, 'image')
  FROM attachments a JOIN messages m ON m.id = a.message_id
  WHERE m.deleted_at IS NOT NULL AND a.public_id IS NOT NULL
  ON CONFLICT DO NOTHING;
UPDATE file_uploads f SET retired_at = NOW()
  FROM messages m WHERE f.attached_message_id = m.id AND m.deleted_at IS NOT NULL;
