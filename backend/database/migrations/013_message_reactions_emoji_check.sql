-- Constrain message_reactions.emoji to the agreed set.
--
-- `emoji` is a bare TEXT column and nothing validated it, so any string could be
-- stored in a field the client renders as a reaction chip. Constraining it here
-- rather than only in the controller makes the guarantee structural: any future
-- write path inherits it, exactly as tasks.status does after migration 011.
--
-- Why these four and not a heart: ❤️ has two common encodings, U+2764 alone and
-- U+2764 U+FE0F with a variation selector, and Postgres treats them as DIFFERENT
-- strings. Verified: inserting both against a UNIQUE (message_id, user_id, emoji)
-- constraint produces two rows, not a conflict. So a heart in the allowlist would
-- either reject a legitimate reaction with an opaque 23514, or let one visible
-- heart stack twice. None of the four below has a variation-selector variant, so
-- there is exactly one byte sequence per emoji and the constraint is unambiguous.
--
-- Locking: the development table is empty, so this validates instantly. On a
-- populated production table ALTER TABLE ... ADD CONSTRAINT takes an ACCESS
-- EXCLUSIVE lock and rescans the whole table, so the online variant is:
--
--   ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_emoji_check
--     CHECK (...) NOT VALID;
--   ALTER TABLE message_reactions VALIDATE CONSTRAINT message_reactions_emoji_check;
--
-- NOT VALID skips the scan but still enforces the constraint on new rows, and
-- VALIDATE takes only SHARE UPDATE EXCLUSIVE.

ALTER TABLE message_reactions
  ADD CONSTRAINT message_reactions_emoji_check
  CHECK (emoji IN ('👍', '👎', '🎉', '✅'));