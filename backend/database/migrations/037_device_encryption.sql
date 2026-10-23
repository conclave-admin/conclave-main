-- Existing history stays explicitly server-readable. Only newly created DMs
-- and private rooms use the encrypted mode; no silent mixed-history conversion.
ALTER TABLE rooms ADD COLUMN encryption_mode TEXT NOT NULL DEFAULT 'none' CHECK(encryption_mode IN ('none','e2ee-v1'));
ALTER TABLE rooms ADD COLUMN superseded_by UUID REFERENCES rooms(id);
ALTER TABLE messages ADD COLUMN encrypted_payload JSONB;
ALTER TABLE users ADD COLUMN identity_public_key TEXT;
CREATE TABLE encryption_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  box_key TEXT NOT NULL,
  signing_key TEXT NOT NULL,
  certificate JSONB,
  certificate_signature TEXT,
  link_payload TEXT,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '15 minutes'
);
CREATE INDEX encryption_devices_user ON encryption_devices(user_id);
CREATE TABLE encryption_backups (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE FUNCTION revoke_encryption_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN UPDATE encryption_devices SET revoked_at=COALESCE(revoked_at,NOW()),link_payload=NULL WHERE session_id=NEW.id; END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER revoke_session_encryption AFTER UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION revoke_encryption_device();
CREATE FUNCTION sync_encryption_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes(kind,operation,entity_id,user_id,private) VALUES('device',TG_OP,NEW.id,NEW.user_id,TRUE);
  RETURN NULL;
END; $$;
CREATE TRIGGER sync_encryption_devices AFTER INSERT OR UPDATE ON encryption_devices FOR EACH ROW EXECUTE FUNCTION sync_encryption_device();
