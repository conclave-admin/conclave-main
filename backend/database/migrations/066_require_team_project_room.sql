-- Team projects are useful only as an organizer for existing team rooms. Check
-- at transaction end so creation may insert the project before its first links.
CREATE OR REPLACE FUNCTION enforce_project_room_team_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_team_id UUID;
  room_team_id UUID;
  room_type TEXT;
BEGIN
  SELECT team_id INTO project_team_id FROM projects WHERE id = NEW.project_id;
  SELECT team_id, type INTO room_team_id, room_type FROM rooms WHERE id = NEW.room_id;

  IF room_type = 'dm' OR project_team_id IS DISTINCT FROM room_team_id THEN
    RAISE EXCEPTION 'Project rooms must belong to the same team and cannot be direct messages'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_room_team_match
BEFORE INSERT OR UPDATE OF project_id, room_id ON project_rooms
FOR EACH ROW EXECUTE FUNCTION enforce_project_room_team_match();

CREATE OR REPLACE FUNCTION enforce_team_project_has_room()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_id_to_check UUID;
  project_team_id UUID;
BEGIN
  project_id_to_check := CASE
    WHEN TG_TABLE_NAME = 'projects' THEN NEW.id
    WHEN TG_OP = 'DELETE' THEN OLD.project_id
    ELSE OLD.project_id
  END;

  SELECT team_id INTO project_team_id
  FROM projects
  WHERE id = project_id_to_check;

  -- A deleted project needs no room. Retained personal projects predate the
  -- team-only beta policy and remain outside this invariant.
  IF NOT FOUND OR project_team_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM project_rooms WHERE project_id = project_id_to_check
  ) THEN
    RAISE EXCEPTION 'A team project must contain at least one room'
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'project_rooms' AND TG_OP = 'UPDATE'
     AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    SELECT team_id INTO project_team_id FROM projects WHERE id = NEW.project_id;
    IF project_team_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_rooms WHERE project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'A team project must contain at least one room'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER team_project_requires_room
AFTER INSERT OR UPDATE ON projects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_team_project_has_room();

CREATE CONSTRAINT TRIGGER team_project_retains_room
AFTER DELETE OR UPDATE ON project_rooms
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_team_project_has_room();
