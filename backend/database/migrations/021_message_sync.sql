ALTER TABLE rooms ADD COLUMN message_sequence BIGINT NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN client_id UUID;
ALTER TABLE messages ADD COLUMN room_sequence BIGINT;
ALTER TABLE room_members ADD COLUMN last_seen_sequence BIGINT NOT NULL DEFAULT 0;
ALTER TABLE room_members ADD COLUMN last_delivered_sequence BIGINT NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at, id) AS seq
  FROM messages
)
UPDATE messages m SET room_sequence = ranked.seq FROM ranked WHERE ranked.id = m.id;

UPDATE rooms r SET message_sequence = COALESCE((
  SELECT MAX(m.room_sequence) FROM messages m WHERE m.room_id = r.id
), 0);

UPDATE room_members rm SET last_seen_sequence = COALESCE((
  SELECT MAX(m.room_sequence) FROM messages m
   WHERE m.room_id = rm.room_id AND m.created_at <= rm.last_seen_at
), 0);

CREATE UNIQUE INDEX idx_messages_room_sender_client
  ON messages(room_id, sender_id, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX idx_messages_room_sequence
  ON messages(room_id, room_sequence) WHERE room_sequence IS NOT NULL;
