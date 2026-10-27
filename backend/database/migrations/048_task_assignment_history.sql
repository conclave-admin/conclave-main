-- Preserve assignment changes as facts so the digest can describe them later.
ALTER TABLE task_updates
  ADD COLUMN old_assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN new_assignee_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tasks ADD COLUMN initial_assignee_id UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE tasks SET initial_assignee_id=assignee_id;

CREATE INDEX task_updates_recent ON task_updates(created_at DESC, id DESC);
