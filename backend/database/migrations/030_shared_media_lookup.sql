-- Bound each message's attachment lookup, including legacy multi-file messages.
CREATE INDEX idx_attachments_message_id_id ON attachments(message_id, id DESC);
