-- The original constraint trigger tried to read OLD.project_id for project
-- rows, which have no such column. Resolve IDs by table and event before
-- checking the deferred invariant.
CREATE OR REPLACE FUNCTION assert_team_project_has_room(project_id_to_check UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  project_team_id UUID;
BEGIN
  SELECT team_id INTO project_team_id
  FROM projects
  WHERE id = project_id_to_check;

  -- Deleted projects and legacy personal projects are outside this rule.
  IF NOT FOUND OR project_team_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM project_rooms WHERE project_id = project_id_to_check
  ) THEN
    RAISE EXCEPTION 'A team project must contain at least one room'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_team_project_has_room()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM assert_team_project_has_room(NEW.id);
    END IF;
  ELSE
    -- On link updates, both the previous and new projects must retain a room.
    IF TG_OP <> 'INSERT' THEN
      PERFORM assert_team_project_has_room(OLD.project_id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM assert_team_project_has_room(NEW.project_id);
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
