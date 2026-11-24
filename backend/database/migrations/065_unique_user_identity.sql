-- Make the two user-facing identity fields deterministic before enforcing
-- uniqueness. Deleted accounts may continue sharing the "Deleted user" label;
-- only active accounts participate in display-name uniqueness.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users
    WHERE email IS NOT NULL
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'users contain email addresses that differ only by case or surrounding whitespace',
      HINT = 'Resolve the duplicate accounts before applying migration 065.';
  END IF;
END $$;

UPDATE users
SET email = lower(btrim(email))
WHERE email IS NOT NULL
  AND email IS DISTINCT FROM lower(btrim(email));

CREATE TABLE IF NOT EXISTS identity_migration_065_changes (
  user_id UUID PRIMARY KEY,
  previous_display_name TEXT NOT NULL,
  normalized_display_name TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('normalized', 'collision', 'reserved')),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  user_record RECORD;
  base_name TEXT;
  candidate TEXT;
  suffix TEXT;
  suffix_number INTEGER;
  change_reason TEXT;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS identity_names_allocated (
    normalized_name TEXT PRIMARY KEY
  ) ON COMMIT DROP;
  TRUNCATE identity_names_allocated;

  FOR user_record IN
    SELECT id, display_name
    FROM users
    WHERE deleted_at IS NULL
    ORDER BY created_at, id
  LOOP
    base_name := btrim(
      regexp_replace(
        regexp_replace(coalesce(user_record.display_name, ''), '[[:cntrl:]]+', ' ', 'g'),
        '[[:space:]]+',
        ' ',
        'g'
      )
    );
    base_name := left(base_name, 100);

    IF base_name = '' OR lower(base_name) = 'deleted user' THEN
      base_name := 'User';
    END IF;

    candidate := base_name;
    change_reason := 'normalized';
    IF lower(btrim(coalesce(user_record.display_name, ''))) = 'deleted user' THEN
      change_reason := 'reserved';
    END IF;
    suffix_number := 1;
    WHILE lower(candidate) = 'deleted user'
      OR EXISTS (
        SELECT 1 FROM identity_names_allocated
        WHERE normalized_name = lower(candidate)
      )
    LOOP
      suffix_number := suffix_number + 1;
      change_reason := 'collision';
      suffix := ' #' || suffix_number::text;
      candidate := left(base_name, 100 - char_length(suffix)) || suffix;
    END LOOP;

    IF candidate IS DISTINCT FROM user_record.display_name THEN
      INSERT INTO identity_migration_065_changes(
        user_id, previous_display_name, normalized_display_name, reason
      ) VALUES (
        user_record.id, user_record.display_name, candidate, change_reason
      ) ON CONFLICT (user_id) DO NOTHING;
      UPDATE users SET display_name = candidate WHERE id = user_record.id;
    END IF;
    INSERT INTO identity_names_allocated(normalized_name) VALUES (lower(candidate));
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_unique
  ON users (lower(btrim(email)))
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_normalized_unique
  ON users (lower(btrim(display_name)))
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname = 'users_email_is_normalized'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_email_is_normalized
      CHECK (email IS NULL OR email = lower(btrim(email)));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname = 'users_active_display_name_is_normalized'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_active_display_name_is_normalized
      CHECK (
        deleted_at IS NOT NULL OR (
          char_length(display_name) BETWEEN 1 AND 100
          AND display_name = btrim(
            regexp_replace(
              regexp_replace(display_name, '[[:cntrl:]]+', ' ', 'g'),
              '[[:space:]]+',
              ' ',
              'g'
            )
          )
          AND lower(display_name) <> 'deleted user'
        )
      );
  END IF;
END $$;
