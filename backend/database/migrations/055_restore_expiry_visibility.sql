-- Migration 051 added team history boundaries but inadvertently omitted the
-- expiry predicate from 041. Preserve both; do not change applied migrations.
CREATE OR REPLACE FUNCTION message_visible(mid UUID,viewer UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM messages m
  JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=viewer
  WHERE m.id=mid AND (m.expires_at IS NULL OR m.expires_at>NOW())
  AND (m.room_sequence>GREATEST(rm.cleared_sequence,rm.history_start_sequence)
    OR (m.room_sequence IS NULL AND rm.cleared_at IS NULL AND rm.history_start_sequence=0))
 );
$$;
