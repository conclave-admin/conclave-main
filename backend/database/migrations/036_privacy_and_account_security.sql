CREATE TABLE privacy_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  online_visibility TEXT NOT NULL DEFAULT 'everyone' CHECK(online_visibility IN ('everyone','connections','nobody')),
  last_seen_visibility TEXT NOT NULL DEFAULT 'connections' CHECK(last_seen_visibility IN ('everyone','connections','nobody')),
  photo_visibility TEXT NOT NULL DEFAULT 'everyone' CHECK(photo_visibility IN ('everyone','connections','nobody')),
  about_visibility TEXT NOT NULL DEFAULT 'connections' CHECK(about_visibility IN ('everyone','connections','nobody')),
  read_receipts BOOLEAN NOT NULL DEFAULT TRUE,
  dm_policy TEXT NOT NULL DEFAULT 'requests' CHECK(dm_policy IN ('everyone','requests','connections','nobody'))
);
ALTER TABLE users ADD COLUMN last_active_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
ALTER TABLE auth_sessions ADD COLUMN device_label TEXT NOT NULL DEFAULT 'Browser';
ALTER TABLE auth_sessions ADD COLUMN user_agent TEXT;
ALTER TABLE auth_sessions ADD COLUMN last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE TABLE account_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX account_tokens_user ON account_tokens(user_id,purpose);
CREATE INDEX account_tokens_expiry ON account_tokens(expires_at);
CREATE TABLE account_mail_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id UUID NOT NULL REFERENCES account_tokens(id) ON DELETE CASCADE,
  encrypted_payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '30 minutes',
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  completed_at TIMESTAMPTZ,
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX account_mail_pending ON account_mail_jobs(next_attempt_at) WHERE completed_at IS NULL;
CREATE TABLE dm_requests (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  recipient_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(sender_id<>recipient_id)
);
CREATE INDEX dm_requests_recipient ON dm_requests(recipient_id,status);
CREATE FUNCTION privacy_connected(owner UUID,viewer UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT owner=viewer OR EXISTS(
    SELECT 1 FROM room_members a JOIN room_members b ON b.room_id=a.room_id
    JOIN rooms r ON r.id=a.room_id LEFT JOIN dm_requests d ON d.room_id=r.id
    WHERE a.user_id=owner AND b.user_id=viewer AND (r.type<>'dm' OR d.room_id IS NULL OR d.status='accepted')
  );
$$;
CREATE FUNCTION privacy_allowed(owner UUID,viewer UUID,field TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT owner=viewer OR (
    NOT EXISTS(SELECT 1 FROM user_blocks WHERE (blocker_id=owner AND blocked_id=viewer) OR (blocker_id=viewer AND blocked_id=owner))
    AND CASE COALESCE((SELECT CASE field WHEN 'photo' THEN photo_visibility WHEN 'about' THEN about_visibility WHEN 'online' THEN online_visibility WHEN 'last_seen' THEN last_seen_visibility END FROM privacy_preferences WHERE user_id=owner),CASE WHEN field IN ('about','last_seen') THEN 'connections' ELSE 'everyone' END)
      WHEN 'everyone' THEN TRUE WHEN 'connections' THEN privacy_connected(owner,viewer) ELSE FALSE END
  );
$$;
CREATE FUNCTION share_dm_reads(room UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM rooms WHERE id=room AND type='dm') OR (
    NOT EXISTS(SELECT 1 FROM dm_requests WHERE room_id=room AND status<>'accepted')
    AND NOT EXISTS(SELECT 1 FROM room_members rm JOIN privacy_preferences p ON p.user_id=rm.user_id WHERE rm.room_id=room AND NOT p.read_receipts)
    AND NOT EXISTS(SELECT 1 FROM room_members a JOIN room_members b ON b.room_id=a.room_id JOIN user_blocks u ON u.blocker_id=a.user_id AND u.blocked_id=b.user_id WHERE a.room_id=room)
  );
$$;
CREATE TRIGGER sync_privacy AFTER INSERT OR UPDATE OR DELETE ON privacy_preferences FOR EACH ROW EXECUTE FUNCTION record_sync_change('preferences');
CREATE FUNCTION queue_session_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes(kind,operation,entity_id,user_id,private) VALUES('session','UPDATE',NEW.id,NEW.user_id,TRUE);
  RETURN NULL;
END; $$;
CREATE TRIGGER durable_session_revocation AFTER UPDATE OF revoked_at ON auth_sessions FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION queue_session_revocation();
CREATE FUNCTION sync_dm_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes(kind,operation,entity_id,room_id,user_id,private)
  VALUES('room',TG_OP,NEW.room_id,NEW.room_id,NEW.sender_id,TRUE),('room',TG_OP,NEW.room_id,NEW.room_id,NEW.recipient_id,TRUE);
  RETURN NULL;
END; $$;
CREATE TRIGGER sync_dm_requests AFTER INSERT OR UPDATE ON dm_requests FOR EACH ROW EXECUTE FUNCTION sync_dm_request();

-- Attention heartbeats must not invalidate every cached sender profile.
CREATE OR REPLACE FUNCTION increment_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'last_active_at'-'profile_version') IS DISTINCT FROM (to_jsonb(OLD)-'last_active_at'-'profile_version') THEN
    NEW.profile_version:=OLD.profile_version+1;
  ELSE NEW.profile_version:=OLD.profile_version; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER sync_profiles ON users;
CREATE TRIGGER sync_profiles AFTER UPDATE ON users FOR EACH ROW WHEN (OLD.profile_version IS DISTINCT FROM NEW.profile_version) EXECUTE FUNCTION record_sync_change('profile');
