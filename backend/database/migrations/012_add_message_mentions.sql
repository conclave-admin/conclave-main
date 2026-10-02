-- Structured mentions (BACKEND_TASKS.md item H).
--
-- Mentions were previously derived by regex-matching message content against each
-- room member's display_name. That is correct about boundaries but wrong about
-- identity: a display name is not an identity, so renaming a user silently changes
-- who gets notified for every message they were named in (Bug 9). Worse,
-- display_name is NOT unique -- only email is -- so two members can share a name
-- and a text mention cannot tell them apart.
--
-- This table records who was actually mentioned, by id, at send time. Both the
-- digest and mention notifications read it instead of the message text.
--
-- Composite primary key rather than a surrogate id: a client that mentions
-- someone twice should record them once, not error. ON DELETE CASCADE on both
-- foreign keys means a deleted message or account leaves nothing behind for the
-- digest to join against.
--
-- The index leads with user_id because both digest queries read by recipient
-- ("messages that mention ME"), not by message.

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_mentions_user
  ON message_mentions (user_id, message_id);