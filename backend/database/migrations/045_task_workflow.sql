-- Task progress is append-only so collaborators can see what happened.
CREATE TABLE task_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('note', 'status', 'details')),
  body TEXT,
  old_status TEXT,
  new_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX task_updates_task_recent ON task_updates(task_id, created_at DESC, id DESC);
CREATE INDEX tasks_room_recent ON tasks(room_id, updated_at DESC, id DESC);
