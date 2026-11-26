-- Patch the team-project room invariant for deployments that already applied 066.
CREATE OR REPLACE FUNCTION enforce_team_project_has_room()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project_id_to_check UUID;
  project_team_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    project_id_to_check := NEW.id;
  ELSIF TG_TABLE_NAME = 'project_rooms' THEN
    IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      project_id_to_check := OLD.project_id;
      SELECT team_id INTO project_team_id FROM projects WHERE id = project_id_to_check;
      IF project_team_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM project_rooms WHERE project_id = project_id_to_check
      ) THEN
        RAISE EXCEPTION 'A team project must contain at least one room'
          USING ERRCODE = '23514';
      END IF;
      project_id_to_check := NEW.project_id;
    ELSE
      project_id_to_check := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
    END IF;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT team_id INTO project_team_id
  FROM projects
  WHERE id = project_id_to_check;

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

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
