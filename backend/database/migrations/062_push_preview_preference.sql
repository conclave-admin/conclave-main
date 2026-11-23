-- Opt-out control for rich push previews (sender name + message preview).
-- Defaults to TRUE so existing users get the richer notification unless they
-- turn it off, matching the agreed default-on product decision. Push payload
-- content itself continues to respect mutes, blocks, DND and foreground
-- suppression, computed separately in notificationPolicy.service.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS push_preview_enabled BOOLEAN NOT NULL DEFAULT TRUE;
