-- Give each independently addressable media message an optional album group.
-- Existing multi-attachment messages remain readable; new message writes are
-- constrained to one attachment in message.service.js.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS album_id UUID;

CREATE INDEX IF NOT EXISTS idx_messages_room_album
  ON messages (room_id, album_id, room_sequence)
  WHERE album_id IS NOT NULL;
