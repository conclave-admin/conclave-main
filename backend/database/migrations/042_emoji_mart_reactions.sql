-- The API validates reactions against the installed Emoji Mart dataset, which
-- includes skin-tone and joined emoji sequences. A fixed SQL list cannot track
-- that dataset without rejecting valid picker selections.
ALTER TABLE message_reactions DROP CONSTRAINT IF EXISTS message_reactions_emoji_check;
