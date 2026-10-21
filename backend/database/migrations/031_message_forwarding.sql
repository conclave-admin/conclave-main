ALTER TABLE messages ADD COLUMN forwarded BOOLEAN NOT NULL DEFAULT FALSE;
-- No source-room IDs are exposed to recipients. Access is granted by the new
-- attachment's own message/room, never by knowing a shared storage key.
