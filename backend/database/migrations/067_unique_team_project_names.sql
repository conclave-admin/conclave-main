-- Project names identify work within a team. Normalize historical values and
-- resolve collisions deterministically before enforcing the beta contract.
CREATE TABLE IF NOT EXISTS identity_migration_067_project_changes (
  project_id UUID PRIMARY KEY,
  team_id UUID NOT NULL,
  previous_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  project_record RECORD;
  base_name TEXT;
  candidate TEXT;
  suffix TEXT;
  suffix_number INTEGER;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS project_names_allocated (
    team_id UUID NOT NULL,
    normalized_name TEXT NOT NULL,
    PRIMARY KEY(team_id, normalized_name)
  ) ON COMMIT DROP;
  TRUNCATE project_names_allocated;

  FOR project_record IN
    SELECT id, team_id, name
    FROM projects
    WHERE team_id IS NOT NULL
    ORDER BY team_id, created_at, id
  LOOP
    base_name := left(btrim(regexp_replace(project_record.name, '[[:space:]]+', ' ', 'g')), 160);
    IF base_name = '' THEN base_name := 'Project'; END IF;
    candidate := base_name;
    suffix_number := 1;
    WHILE EXISTS (
      SELECT 1 FROM project_names_allocated
      WHERE team_id = project_record.team_id
        AND normalized_name = lower(candidate)
    ) LOOP
      suffix_number := suffix_number + 1;
      suffix := ' #' || suffix_number::text;
      candidate := left(base_name, 160 - char_length(suffix)) || suffix;
    END LOOP;

    IF candidate IS DISTINCT FROM project_record.name THEN
      INSERT INTO identity_migration_067_project_changes(
        project_id, team_id, previous_name, normalized_name
      ) VALUES (
        project_record.id, project_record.team_id, project_record.name, candidate
      ) ON CONFLICT (project_id) DO NOTHING;
      UPDATE projects SET name = candidate WHERE id = project_record.id;
    END IF;
    INSERT INTO project_names_allocated(team_id, normalized_name)
    VALUES(project_record.team_id, lower(candidate));
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS projects_team_normalized_name_unique
  ON projects(team_id, lower(btrim(name)))
  WHERE team_id IS NOT NULL;
