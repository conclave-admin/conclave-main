ALTER TABLE tasks ADD COLUMN decision_id UUID REFERENCES decisions(id) ON DELETE SET NULL;

CREATE INDEX tasks_decision_status_idx ON tasks (decision_id, status)
  WHERE decision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION task_decision_same_room() RETURNS trigger AS $$
BEGIN
  IF NEW.decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM decisions d WHERE d.id = NEW.decision_id AND d.room_id = NEW.room_id
  ) THEN
    RAISE EXCEPTION 'Task decision must belong to the same conversation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_decision_room_guard BEFORE INSERT OR UPDATE OF room_id, decision_id
  ON tasks FOR EACH ROW EXECUTE FUNCTION task_decision_same_room();
