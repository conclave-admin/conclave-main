ALTER TABLE tasks ADD COLUMN client_id UUID;
CREATE UNIQUE INDEX tasks_creator_client_id ON tasks(created_by, client_id)
  WHERE client_id IS NOT NULL;
