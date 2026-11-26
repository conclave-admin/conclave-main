-- Recipient lists are immutable facts about a send, independent of membership.
ALTER TABLE messages ADD COLUMN receipt_history_complete BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE messages ADD COLUMN receipt_version BIGINT NOT NULL DEFAULT 0;
UPDATE messages SET receipt_history_complete = FALSE;
CREATE TABLE message_recipients (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- Retained if an account or membership is removed; never grants file access.
  recipient_id UUID NOT NULL,
  recipient_name TEXT NOT NULL,
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, recipient_id),
  CHECK (NOT read OR delivered)
);
CREATE INDEX idx_message_recipients_user ON message_recipients(recipient_id, message_id);
-- We can reconstruct only surviving memberships, and cannot recover ack times.
INSERT INTO message_recipients(message_id, recipient_id, recipient_name, delivered, read)
SELECT m.id, rm.user_id, u.display_name,
       COALESCE(rm.last_delivered_sequence >= m.room_sequence OR rm.last_seen_sequence >= m.room_sequence, FALSE),
       COALESCE(rm.last_seen_sequence >= m.room_sequence, FALSE)
FROM messages m JOIN room_members rm ON rm.room_id = m.room_id
JOIN users u ON u.id = rm.user_id
WHERE rm.user_id <> m.sender_id AND rm.joined_at <= m.created_at;
CREATE FUNCTION snapshot_message_recipients() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Room membership mutations and sends take this same lock.
  PERFORM id FROM rooms WHERE id = NEW.room_id FOR UPDATE;
  INSERT INTO message_recipients(message_id, recipient_id, recipient_name)
    SELECT NEW.id, rm.user_id, u.display_name FROM room_members rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = NEW.room_id AND rm.user_id <> NEW.sender_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_recipient_snapshot AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION snapshot_message_recipients();
