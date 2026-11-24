ALTER TABLE users
  ADD COLUMN suspended_at TIMESTAMPTZ,
  ADD COLUMN suspended_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN suspension_reason TEXT CHECK (suspension_reason IS NULL OR char_length(suspension_reason) <= 1000);

CREATE INDEX users_active_suspensions ON users(suspended_at) WHERE suspended_at IS NOT NULL;
CREATE INDEX user_reports_page ON user_reports(created_at DESC, id DESC);

CREATE TABLE moderation_audit (
  id BIGSERIAL PRIMARY KEY,
  -- Keep immutable identifiers as values rather than FKs. ON DELETE SET NULL
  -- would mutate an audit row and be rejected by the append-only trigger.
  report_id UUID,
  actor_user_id UUID,
  subject_user_id UUID,
  action TEXT NOT NULL CHECK (action IN (
    'report_viewed', 'report_transition', 'account_suspended', 'account_restored',
    'platform_role_granted', 'platform_role_revoked'
  )),
  from_status TEXT,
  to_status TEXT,
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 1000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX moderation_audit_report ON moderation_audit(report_id, created_at DESC, id DESC);
CREATE INDEX moderation_audit_subject ON moderation_audit(subject_user_id, created_at DESC, id DESC);

CREATE FUNCTION prevent_moderation_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Moderation audit records are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER moderation_audit_immutable
  BEFORE UPDATE OR DELETE ON moderation_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_moderation_audit_mutation();
