-- User-wide recurring quiet windows. Days use JavaScript numbering (Sunday=0).
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS quiet_hours JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS quiet_hours_timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_quiet_hours_shape;
ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_quiet_hours_shape
  CHECK (CASE WHEN jsonb_typeof(quiet_hours) = 'array'
    THEN jsonb_array_length(quiet_hours) <= 7 ELSE FALSE END);

ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_quiet_hours_timezone_shape;
ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_quiet_hours_timezone_shape
  CHECK (length(quiet_hours_timezone) BETWEEN 1 AND 100);
