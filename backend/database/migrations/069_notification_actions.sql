-- Short-lived, single-use capabilities let a service worker perform only the
-- notification action shown on one specific push, without storing an API token
-- in the worker. Removing the subscription/session/account invalidates them.
CREATE TABLE notification_action_tokens (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  binding_id UUID NOT NULL,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('mark_read')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX notification_action_tokens_expiry ON notification_action_tokens(expires_at);
