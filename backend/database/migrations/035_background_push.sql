ALTER TABLE notifications ADD COLUMN dedupe_key TEXT UNIQUE;
CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  binding_id UUID NOT NULL DEFAULT gen_random_uuid(),
  renewal_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX push_subscription_session ON push_subscriptions(session_id);
CREATE TABLE push_jobs (
  id BIGSERIAL PRIMARY KEY,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  binding_id UUID NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '15 minutes',
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  completed_at TIMESTAMPTZ,
  outcome TEXT,
  UNIQUE(notification_id,subscription_id)
);
CREATE INDEX push_jobs_pending ON push_jobs(next_attempt_at,id) WHERE completed_at IS NULL;
CREATE FUNCTION enqueue_notification_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO push_jobs(notification_id,subscription_id,binding_id)
    SELECT NEW.id,id,binding_id FROM push_subscriptions WHERE user_id=NEW.recipient_id;
  RETURN NULL;
END; $$;
CREATE TRIGGER notification_push AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION enqueue_notification_push();
-- Revocation immediately invalidates subscription renewal and queued delivery.
CREATE FUNCTION remove_revoked_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN DELETE FROM push_subscriptions WHERE session_id=NEW.id; END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER revoke_session_push AFTER UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION remove_revoked_push();
