CREATE TABLE room_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 140),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 100),
  reminder_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (reminder_at IS NULL OR reminder_at <= starts_at)
);
CREATE INDEX room_events_room_start_idx ON room_events(room_id, starts_at, id)
  WHERE status='scheduled';
CREATE INDEX room_events_reminder_idx ON room_events(reminder_at, id)
  WHERE status='scheduled' AND reminder_at IS NOT NULL;

CREATE TABLE room_event_rsvps (
  event_id UUID NOT NULL REFERENCES room_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response TEXT NOT NULL CHECK (response IN ('yes','maybe','no')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(event_id,user_id)
);
CREATE INDEX room_event_rsvps_user_idx ON room_event_rsvps(user_id,event_id);

-- Each scheduled reminder is uniquely keyed by event/member. Jobs use leases so
-- multiple API processes can safely share the worker.
CREATE TABLE room_event_reminder_jobs (
  event_id UUID NOT NULL REFERENCES room_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY(event_id,user_id)
);
CREATE INDEX room_event_reminder_due_idx ON room_event_reminder_jobs(due_at)
  WHERE completed_at IS NULL;
