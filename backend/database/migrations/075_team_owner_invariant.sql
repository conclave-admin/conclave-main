-- Reconcile legacy owner rows with teams.owner_id before adding deferred guards.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM teams t JOIN users u ON u.id=t.owner_id
    WHERE u.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A deleted account still owns a team; restore its access or transfer ownership before migration 075'
      USING ERRCODE='23514';
  END IF;
END $$;

DELETE FROM team_members tm
USING users u
WHERE tm.user_id=u.id AND u.deleted_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id=tm.team_id AND t.owner_id=tm.user_id);

DELETE FROM team_pending_room_grants grant_row
USING users u WHERE grant_row.user_id=u.id AND u.deleted_at IS NOT NULL;
DELETE FROM team_join_requests request_row
USING users u WHERE request_row.user_id=u.id AND u.deleted_at IS NOT NULL;
UPDATE team_invites invite_row SET revoked_at=COALESCE(invite_row.revoked_at,NOW())
FROM users u WHERE invite_row.created_by=u.id AND u.deleted_at IS NOT NULL;

UPDATE team_members tm SET role='member'
FROM teams t
WHERE tm.team_id=t.id AND tm.role='owner' AND tm.user_id<>t.owner_id;

INSERT INTO team_members(team_id,user_id,role)
SELECT id,owner_id,'owner' FROM teams
ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner';

UPDATE room_members rm SET
  role=CASE WHEN rm.independent_admin THEN 'admin' ELSE 'member' END,
  team_owner_grant=FALSE
FROM rooms r
WHERE r.id=rm.room_id AND r.team_id IS NOT NULL AND rm.team_owner_grant
  AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id=r.team_id AND t.owner_id=rm.user_id);

INSERT INTO room_members(room_id,user_id,role,cleared_sequence,history_start_sequence,team_owner_grant,independent_admin)
SELECT r.id,t.owner_id,'admin',COALESCE(r.message_sequence,0),COALESCE(r.message_sequence,0),TRUE,FALSE
FROM rooms r JOIN teams t ON t.id=r.team_id
ON CONFLICT(room_id,user_id) DO UPDATE SET role='admin',team_owner_grant=TRUE;

CREATE TABLE team_audit_events (
  id BIGSERIAL PRIMARY KEY,
  team_id UUID NOT NULL,
  actor_user_id UUID,
  actor_label TEXT,
  action TEXT NOT NULL CHECK(action IN ('owner_transferred','owner_recovered')),
  previous_owner_id UUID NOT NULL,
  new_owner_id UUID NOT NULL,
  reason TEXT CHECK(reason IS NULL OR length(reason)<=1000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(actor_user_id IS NOT NULL OR actor_label IS NOT NULL),
  CHECK(previous_owner_id<>new_owner_id)
);
CREATE INDEX team_audit_events_history ON team_audit_events(team_id,created_at DESC,id DESC);
CREATE FUNCTION prevent_team_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Team audit records are append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER team_audit_events_immutable
  BEFORE UPDATE OR DELETE ON team_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_team_audit_mutation();

ALTER TABLE teams ADD CONSTRAINT teams_owner_is_member
  FOREIGN KEY(id,owner_id) REFERENCES team_members(team_id,user_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION assert_team_owner_pair(team_key UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  expected_owner UUID;
  owner_count INTEGER;
  matching_count INTEGER;
BEGIN
  SELECT owner_id INTO expected_owner FROM teams WHERE id=team_key FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*)::int,count(*) FILTER(WHERE user_id=expected_owner)::int
    INTO owner_count,matching_count
    FROM team_members WHERE team_id=team_key AND role='owner';
  IF owner_count<>1 OR matching_count<>1 THEN
    RAISE EXCEPTION 'A team must have exactly one owner matching teams.owner_id'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE FUNCTION enforce_team_owner_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_team UUID;
BEGIN
  IF TG_TABLE_NAME='teams' THEN
    IF TG_OP<>'DELETE' THEN PERFORM assert_team_owner_pair(NEW.id); END IF;
    IF TG_OP<>'INSERT' THEN
      current_team:=OLD.id;
      IF TG_OP='DELETE' OR current_team IS DISTINCT FROM NEW.id THEN
        PERFORM assert_team_owner_pair(current_team);
      END IF;
    END IF;
  ELSE
    IF TG_OP<>'DELETE' THEN PERFORM assert_team_owner_pair(NEW.team_id); END IF;
    IF TG_OP<>'INSERT' THEN
      current_team:=OLD.team_id;
      IF TG_OP='DELETE' OR current_team IS DISTINCT FROM NEW.team_id THEN
        PERFORM assert_team_owner_pair(current_team);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER teams_owner_pair_guard
  AFTER INSERT OR UPDATE OR DELETE ON teams
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION enforce_team_owner_pair();
CREATE CONSTRAINT TRIGGER team_members_owner_pair_guard
  AFTER INSERT OR UPDATE OR DELETE ON team_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION enforce_team_owner_pair();
