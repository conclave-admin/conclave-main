-- Room-bound opaque ciphertext. File names, MIME types, keys and thumbnails
-- remain inside MLS application messages, never in object metadata.
CREATE TABLE encryption_v2_objects (
 id UUID PRIMARY KEY,
 room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 logical_message_id UUID NOT NULL,
 sender_device_id UUID NOT NULL REFERENCES encryption_v2_devices(id),
 object_key TEXT NOT NULL UNIQUE,
 digest BYTEA NOT NULL CHECK(octet_length(digest)=32),
 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 17 AND 1048592),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX encryption_v2_objects_event ON encryption_v2_objects(room_id,logical_message_id);
