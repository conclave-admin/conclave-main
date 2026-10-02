-- Notifications could not say who caused them. The row recorded a recipient and
-- a polymorphic reference, but no actor, so a room_invite could report which
-- room and never who invited you — the inviter is recorded nowhere else, so
-- this cannot be backfilled from existing columns.
--
-- ON DELETE SET NULL rather than CASCADE: a notification is worth keeping even
-- if its actor is hard-deleted, it just loses the name.

ALTER TABLE notifications ADD COLUMN actor_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Every list query resolves the actor for display, so index it.
CREATE INDEX IF NOT EXISTS idx_notifications_actor ON notifications (actor_id);
