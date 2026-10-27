-- Keep the facts shown in a digest stable after later task edits.
ALTER TABLE tasks
  ADD COLUMN initial_title TEXT,
  ADD COLUMN initial_due_date DATE;

UPDATE tasks SET initial_title=title, initial_due_date=due_date;

ALTER TABLE task_updates
  ADD COLUMN event_title TEXT,
  ADD COLUMN old_title TEXT,
  ADD COLUMN new_title TEXT,
  ADD COLUMN old_due_date DATE,
  ADD COLUMN new_due_date DATE;

CREATE INDEX decision_revisions_digest_recent ON decision_revisions(changed_at DESC, id DESC);
CREATE INDEX tasks_digest_created ON tasks(created_at DESC, id DESC);
CREATE INDEX attachments_digest_recent ON attachments(created_at DESC, id DESC);
CREATE INDEX message_pins_digest_recent ON message_pins(pinned_at DESC, message_id DESC)
  WHERE scope='room';
