ALTER TABLE voice_calls ALTER COLUMN callee_id DROP NOT NULL;
ALTER TABLE voice_calls
  ADD COLUMN IF NOT EXISTS call_type TEXT NOT NULL DEFAULT 'audio'
  CHECK (call_type IN ('audio','video'));

CREATE TABLE IF NOT EXISTS voice_call_participants (
  call_id UUID NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('caller','invitee')),
  status TEXT NOT NULL CHECK (status IN ('invited','accepted','declined','missed','left')),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  PRIMARY KEY (call_id,user_id),
  CHECK (status<>'accepted' OR joined_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS voice_call_participant_history
  ON voice_call_participants(user_id,invited_at DESC);
CREATE INDEX IF NOT EXISTS voice_call_active_participants
  ON voice_call_participants(user_id,call_id) WHERE status IN ('invited','accepted');

INSERT INTO voice_call_participants(call_id,user_id,role,status,joined_at,left_at)
SELECT id,caller_id,'caller',
       CASE WHEN status IN ('ringing','answered') THEN 'accepted' ELSE 'left' END,
       CASE WHEN status IN ('ringing','answered') THEN started_at
            WHEN status='ended' THEN answered_at END,
       CASE WHEN status NOT IN ('ringing','answered') THEN ended_at END
  FROM voice_calls ON CONFLICT DO NOTHING;
INSERT INTO voice_call_participants(call_id,user_id,role,status,invited_at,joined_at,left_at)
SELECT id,callee_id,'invitee',
       CASE WHEN status='answered' THEN 'accepted'
            WHEN status='ended' THEN 'left'
            WHEN status IN ('declined','cancelled','missed','failed') THEN 'declined'
            ELSE 'invited' END,
       started_at,CASE WHEN status='answered' THEN answered_at END,
       CASE WHEN status IN ('declined','cancelled','missed','failed','ended') THEN ended_at END
  FROM voice_calls WHERE callee_id IS NOT NULL ON CONFLICT DO NOTHING;
