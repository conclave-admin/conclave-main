-- Album ownership is checked across conversations while accepting each item.
CREATE INDEX IF NOT EXISTS idx_messages_album_owner
  ON messages (album_id, room_id, sender_id)
  WHERE album_id IS NOT NULL;
