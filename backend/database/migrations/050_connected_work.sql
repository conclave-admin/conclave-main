-- Projects organize existing conversations without changing room membership.
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE project_rooms (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  room_id UUID NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id,room_id)
);
CREATE INDEX project_rooms_project ON project_rooms(project_id);

CREATE TABLE project_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  due_date DATE,
  completed_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id,project_id)
);
ALTER TABLE tasks ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN milestone_id UUID;
ALTER TABLE tasks ADD CONSTRAINT task_milestone_project
  FOREIGN KEY (milestone_id,project_id) REFERENCES project_milestones(id,project_id) ON DELETE SET NULL (milestone_id);
CREATE INDEX tasks_project_status ON tasks(project_id,status,due_date);
CREATE TABLE task_dependencies (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id,depends_on_id),
  CHECK (task_id<>depends_on_id)
);
CREATE INDEX task_dependencies_parent ON task_dependencies(depends_on_id);

CREATE TABLE room_briefs (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE room_brief_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  changed_by UUID NOT NULL REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(room_id,version)
);

CREATE TABLE work_inbox_state (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK (char_length(event_key)<=100),
  state TEXT NOT NULL CHECK (state IN ('done','snoozed')),
  snoozed_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id,event_key)
);

CREATE TABLE project_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('decision_recorded','task_overdue')),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('create_task','notify_assignee')),
  title_prefix TEXT NOT NULL DEFAULT 'Follow up:',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((trigger_kind='decision_recorded' AND action_kind='create_task') OR
         (trigger_kind='task_overdue' AND action_kind='notify_assignee')),
  UNIQUE(project_id,trigger_kind)
);
CREATE TABLE project_automation_runs (
  rule_id UUID NOT NULL REFERENCES project_automations(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  result_id UUID,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(rule_id,event_key)
);
