-- Stable session identity survives refresh-token rotation and backs both REST
-- and realtime authorization. Legacy tokens require a fresh sign-in.
CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
ALTER TABLE refresh_tokens ADD COLUMN session_id UUID REFERENCES auth_sessions(id) ON DELETE CASCADE;
CREATE INDEX refresh_tokens_session ON refresh_tokens(session_id);
UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE session_id IS NULL;
