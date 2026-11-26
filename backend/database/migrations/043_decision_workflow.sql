-- Decisions are durable records. Corrections and retractions keep an audit trail
-- instead of erasing a choice that other members may have acted on.
ALTER TABLE decisions
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retracted'));

UPDATE decisions SET updated_at = created_at;

-- Legacy source IDs from another room must not be exposed through a decision.
UPDATE decisions d SET source_message_id = NULL
FROM messages m
WHERE d.source_message_id = m.id AND m.room_id <> d.room_id;

CREATE FUNCTION enforce_decision_source_room() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM messages m
     WHERE m.id = NEW.source_message_id AND m.room_id = NEW.room_id
  ) THEN
    RAISE EXCEPTION 'Decision source must belong to its room' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER enforce_decision_source_room
  BEFORE INSERT OR UPDATE OF source_message_id, room_id ON decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_decision_source_room();

CREATE TABLE decision_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT[] NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retracted')),
  note TEXT,
  changed_by UUID NOT NULL REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (decision_id, version)
);

INSERT INTO decision_revisions
  (decision_id, version, title, body, tags, status, changed_by, changed_at)
SELECT id, 1, title, body, tags, 'active', created_by, created_at
FROM decisions;

CREATE INDEX decisions_room_recent
  ON decisions(room_id, created_at DESC, id DESC);

CREATE FUNCTION reject_retracted_decision_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status TEXT;
BEGIN
  IF NEW.scope = 'room' THEN
    SELECT status INTO current_status FROM decisions WHERE id = NEW.decision_id FOR SHARE;
    IF current_status = 'retracted' THEN
      RAISE EXCEPTION 'Retracted decisions cannot be pinned for the room'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER reject_retracted_decision_pin
  BEFORE INSERT OR UPDATE ON decision_pins
  FOR EACH ROW EXECUTE FUNCTION reject_retracted_decision_pin();
