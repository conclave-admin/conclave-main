CREATE TABLE IF NOT EXISTS voice_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  caller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing','answered','declined','missed','cancelled','ended','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  ended_by UUID REFERENCES users(id) ON DELETE SET NULL,
  end_reason TEXT,
  CHECK (caller_id <> callee_id),
  CHECK ((status IN ('answered','ended')) = (answered_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS voice_calls_caller_history
  ON voice_calls(caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_calls_callee_history
  ON voice_calls(callee_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_calls_ringing_expiry
  ON voice_calls(started_at) WHERE status = 'ringing';
