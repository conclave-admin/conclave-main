-- Per-device-independent switch for the in-app alert (toast + short sound)
-- that ChatsContext raises for a new message in a conversation that is not
-- the one on screen.
--
-- A column rather than localStorage because every other notification control
-- lives in notification_preferences and syncs across devices: a user who turns
-- the sound off on their laptop would otherwise still get it on their desktop
-- browser, which reads as the switch not working.
--
-- One column for both the toast and the sound rather than two: they are a
-- single "do not interrupt me inside the app" intent, and two switches that
-- almost always move together is two things to maintain for no extra choice.
-- Delivery still requires the same conditions as push (no active DND window,
-- room not muted, activity_level permits it) — this column only adds an extra
-- reason to stay quiet, never a reason to interrupt.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS in_app_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;
