ALTER TABLE users ADD COLUMN suspension_case_id UUID;
UPDATE users SET suspension_case_id=gen_random_uuid() WHERE suspended_at IS NOT NULL;
CREATE UNIQUE INDEX users_suspension_case_unique ON users(suspension_case_id)
  WHERE suspension_case_id IS NOT NULL;

ALTER TABLE user_reports ADD COLUMN assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX user_reports_assigned_page ON user_reports(assigned_to,status,created_at DESC,id DESC);

ALTER TABLE moderation_audit DROP CONSTRAINT moderation_audit_action_check;
ALTER TABLE moderation_audit ADD CONSTRAINT moderation_audit_action_check CHECK (action IN (
  'report_viewed','report_transition','report_assigned',
  'account_suspended','account_restored','platform_role_granted','platform_role_revoked',
  'appeal_submitted','appeal_assigned','appeal_transition'
));

CREATE TABLE moderation_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id UUID NOT NULL,
  suspension_case_id UUID,
  report_id UUID,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 5 AND 3000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','upheld','reversed')),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT CHECK (resolution IS NULL OR length(resolution)<=1000),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (suspension_case_id IS NOT NULL OR report_id IS NOT NULL)
);
CREATE UNIQUE INDEX moderation_appeal_suspension_once
  ON moderation_appeals(suspension_case_id) WHERE suspension_case_id IS NOT NULL AND report_id IS NULL;
CREATE UNIQUE INDEX moderation_appeal_report_once
  ON moderation_appeals(subject_user_id,report_id) WHERE report_id IS NOT NULL;
CREATE INDEX moderation_appeals_queue ON moderation_appeals(status,created_at DESC,id DESC);
CREATE INDEX moderation_appeals_assigned ON moderation_appeals(assigned_to,status,created_at DESC);
CREATE INDEX moderation_appeals_subject ON moderation_appeals(subject_user_id,created_at DESC,id DESC);
