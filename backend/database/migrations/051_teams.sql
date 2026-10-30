CREATE TABLE teams (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
 description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
 avatar_url TEXT,
 created_by UUID NOT NULL REFERENCES users(id),
 owner_id UUID NOT NULL REFERENCES users(id),
 creation_key UUID,
 general_room_id UUID REFERENCES rooms(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX teams_creation_key ON teams(created_by,creation_key) WHERE creation_key IS NOT NULL;
CREATE TABLE team_members (
 team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
 joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(team_id,user_id)
);
CREATE UNIQUE INDEX team_one_owner ON team_members(team_id) WHERE role='owner';
CREATE INDEX team_members_user ON team_members(user_id,team_id);
ALTER TABLE rooms ADD COLUMN team_id UUID REFERENCES teams(id);
ALTER TABLE rooms ADD COLUMN team_discoverable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rooms ADD CONSTRAINT team_room_not_dm CHECK (team_id IS NULL OR type <> 'dm');
CREATE INDEX rooms_team ON rooms(team_id);
CREATE INDEX rooms_team_discovery ON rooms(created_at DESC) WHERE team_discoverable;
ALTER TABLE projects ADD COLUMN team_id UUID REFERENCES teams(id);
CREATE INDEX projects_team ON projects(team_id);
ALTER TABLE room_members ADD COLUMN team_owner_grant BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE room_members ADD COLUMN independent_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE room_members ADD COLUMN history_start_sequence BIGINT NOT NULL DEFAULT 0 CHECK(history_start_sequence>=0);
CREATE TABLE team_invites (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, email_normalized TEXT,
 created_by UUID NOT NULL REFERENCES users(id),
 expires_at TIMESTAMPTZ NOT NULL, max_uses INT NOT NULL CHECK(max_uses BETWEEN 1 AND 100),
 uses INT NOT NULL DEFAULT 0 CHECK(uses>=0), revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX team_invites_team ON team_invites(team_id);
ALTER TABLE account_mail_jobs ALTER COLUMN token_id DROP NOT NULL;
ALTER TABLE account_mail_jobs ADD COLUMN team_invite_id UUID REFERENCES team_invites(id) ON DELETE CASCADE;
ALTER TABLE account_mail_jobs ADD CONSTRAINT mail_job_one_subject CHECK
 ((token_id IS NOT NULL AND team_invite_id IS NULL) OR (token_id IS NULL AND team_invite_id IS NOT NULL));
CREATE TABLE team_join_requests (
 team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source_room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_by UUID REFERENCES users(id),
 reviewed_at TIMESTAMPTZ, PRIMARY KEY(team_id,user_id)
);
CREATE TABLE team_pending_room_grants (
 team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(team_id,user_id,room_id)
);
CREATE FUNCTION enforce_project_team_room() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pt UUID; rt UUID;
BEGIN
 SELECT team_id INTO pt FROM projects WHERE id=NEW.project_id;
 SELECT team_id INTO rt FROM rooms WHERE id=NEW.room_id;
 IF pt IS DISTINCT FROM rt THEN RAISE EXCEPTION 'Project and room must belong to the same team' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER project_room_team_guard BEFORE INSERT OR UPDATE ON project_rooms
 FOR EACH ROW EXECUTE FUNCTION enforce_project_team_room();
CREATE FUNCTION enforce_team_assignment_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='rooms' THEN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id AND OLD.team_id IS NOT NULL
   THEN RAISE EXCEPTION 'Team rooms cannot move between teams' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM project_rooms pr JOIN projects p ON p.id=pr.project_id
    WHERE pr.room_id=NEW.id AND p.team_id IS DISTINCT FROM NEW.team_id)
   THEN RAISE EXCEPTION 'Linked project belongs to another team' USING ERRCODE='23514'; END IF;
  IF NEW.team_id IS NOT NULL AND EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=NEW.id
    AND NOT EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=NEW.team_id AND tm.user_id=rm.user_id))
   THEN RAISE EXCEPTION 'Room members must join destination team first' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.team_id IS DISTINCT FROM OLD.team_id AND OLD.team_id IS NOT NULL
   THEN RAISE EXCEPTION 'Team projects cannot move between teams' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM project_rooms pr JOIN rooms r ON r.id=pr.room_id
    WHERE pr.project_id=NEW.id AND r.team_id IS DISTINCT FROM NEW.team_id)
   THEN RAISE EXCEPTION 'Linked room belongs to another team' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER team_room_assignment_guard BEFORE UPDATE OF team_id ON rooms
 FOR EACH ROW EXECUTE FUNCTION enforce_team_assignment_links();
CREATE TRIGGER team_project_assignment_guard BEFORE UPDATE OF team_id ON projects
 FOR EACH ROW EXECUTE FUNCTION enforce_team_assignment_links();
CREATE FUNCTION enforce_team_room_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid UUID;
BEGIN
 SELECT team_id INTO tid FROM rooms WHERE id=NEW.room_id;
 IF tid IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM team_members WHERE team_id=tid AND user_id=NEW.user_id)
 THEN RAISE EXCEPTION 'Room member must belong to its team' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER team_room_member_guard BEFORE INSERT OR UPDATE OF room_id,user_id ON room_members
 FOR EACH ROW EXECUTE FUNCTION enforce_team_room_membership();
CREATE FUNCTION protect_team_owner_room() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid UUID;
BEGIN
 SELECT team_id INTO tid FROM rooms WHERE id=OLD.room_id;
 IF tid IS NOT NULL AND EXISTS(SELECT 1 FROM team_members WHERE team_id=tid AND user_id=OLD.user_id AND role='owner')
   AND (TG_OP='DELETE' OR NEW.role<>'admin' OR NOT NEW.team_owner_grant)
 THEN RAISE EXCEPTION 'Team owner must administer every team room' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER team_owner_room_guard BEFORE UPDATE OR DELETE ON room_members
 FOR EACH ROW EXECUTE FUNCTION protect_team_owner_room();
CREATE OR REPLACE FUNCTION message_visible(mid UUID,viewer UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM messages m JOIN room_members rm ON rm.room_id=m.room_id AND rm.user_id=viewer
 WHERE m.id=mid AND (m.room_sequence>GREATEST(rm.cleared_sequence,rm.history_start_sequence)
 OR (m.room_sequence IS NULL AND rm.cleared_at IS NULL AND rm.history_start_sequence=0)));
$$;
CREATE FUNCTION team_content_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid UUID; archived TIMESTAMPTZ;
BEGIN
 SELECT r.team_id,t.archived_at INTO tid,archived FROM rooms r LEFT JOIN teams t ON t.id=r.team_id
 WHERE r.id=NEW.room_id;
 IF archived IS NOT NULL THEN RAISE EXCEPTION 'Team is archived' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER team_message_write_guard BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION team_content_write_guard();
CREATE TRIGGER team_task_write_guard BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION team_content_write_guard();
CREATE TRIGGER team_decision_write_guard BEFORE INSERT ON decisions FOR EACH ROW EXECUTE FUNCTION team_content_write_guard();
CREATE FUNCTION team_existing_content_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room_id_value UUID; archived TIMESTAMPTZ;
BEGIN
 room_id_value := CASE WHEN TG_OP='DELETE' THEN OLD.room_id ELSE NEW.room_id END;
 SELECT t.archived_at INTO archived FROM rooms r JOIN teams t ON t.id=r.team_id WHERE r.id=room_id_value;
 IF archived IS NOT NULL THEN RAISE EXCEPTION 'Team is archived' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER team_message_change_guard BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION team_existing_content_write_guard();
CREATE TRIGGER team_task_change_guard BEFORE UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION team_existing_content_write_guard();
CREATE TRIGGER team_decision_change_guard BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION team_existing_content_write_guard();
CREATE FUNCTION team_room_membership_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room_id_value UUID; archived TIMESTAMPTZ;
BEGIN
 room_id_value := CASE WHEN TG_OP='DELETE' THEN OLD.room_id ELSE NEW.room_id END;
 SELECT t.archived_at INTO archived FROM rooms r JOIN teams t ON t.id=r.team_id WHERE r.id=room_id_value;
 IF archived IS NOT NULL AND (TG_OP<>'UPDATE' OR NEW.role IS DISTINCT FROM OLD.role
   OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.user_id IS DISTINCT FROM OLD.user_id)
 THEN RAISE EXCEPTION 'Team is archived' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER team_room_membership_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON room_members
 FOR EACH ROW EXECUTE FUNCTION team_room_membership_write_guard();
CREATE FUNCTION team_project_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid UUID; archived TIMESTAMPTZ;
BEGIN
 tid := CASE WHEN TG_OP='DELETE' THEN OLD.team_id ELSE NEW.team_id END;
 SELECT archived_at INTO archived FROM teams WHERE id=tid;
 IF archived IS NOT NULL THEN RAISE EXCEPTION 'Team is archived' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER team_project_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON projects
 FOR EACH ROW EXECUTE FUNCTION team_project_write_guard();
