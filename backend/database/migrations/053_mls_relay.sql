-- MLS-only replacement relay. No room conversion, key import or auto approval.
-- Migration 052 remains intact; its experimental events are never read here.
CREATE TABLE encryption_v2_devices (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 credential BYTEA NOT NULL CHECK(octet_length(credential) BETWEEN 1 AND 65536),
 approval_proof BYTEA CHECK(octet_length(approval_proof) BETWEEN 1 AND 65536),
 approved_at TIMESTAMPTZ,
 revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(id,user_id),
 CHECK(approved_at IS NULL OR approval_proof IS NOT NULL)
);
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_id_user_unique UNIQUE(id,user_id);
CREATE TABLE encryption_v2_session_devices (
 session_id UUID PRIMARY KEY,
 user_id UUID NOT NULL,
 device_id UUID NOT NULL,
 FOREIGN KEY(session_id,user_id) REFERENCES auth_sessions(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(device_id,user_id) REFERENCES encryption_v2_devices(id,user_id) ON DELETE CASCADE
);
CREATE TABLE encryption_v2_mls_rooms (
 room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
 group_id UUID NOT NULL UNIQUE,
 epoch BIGINT NOT NULL DEFAULT 0 CHECK(epoch>=0),
 last_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 roster_generation BIGINT NOT NULL DEFAULT 0 CHECK(roster_generation>=0),
 removal_pending BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE encryption_v2_device_grants (
 room_id UUID NOT NULL REFERENCES encryption_v2_mls_rooms(room_id) ON DELETE CASCADE,
 device_id UUID NOT NULL,
 user_id UUID NOT NULL,
 start_sequence BIGINT NOT NULL CHECK(start_sequence>=0),
 state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')),
 removed_epoch BIGINT CHECK(removed_epoch>=0),
 FOREIGN KEY(device_id,user_id) REFERENCES encryption_v2_devices(id,user_id) ON DELETE CASCADE,
 PRIMARY KEY(room_id,device_id)
);
CREATE TABLE encryption_v2_mls_packages (
 id UUID PRIMARY KEY,
 device_id UUID NOT NULL REFERENCES encryption_v2_devices(id) ON DELETE CASCADE,
 payload BYTEA NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 65536),
 digest BYTEA NOT NULL UNIQUE CHECK(octet_length(digest)=32),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '30 days')
);
CREATE INDEX encryption_v2_mls_packages_available ON encryption_v2_mls_packages(device_id,created_at,id) WHERE consumed_at IS NULL;
CREATE TABLE encryption_v2_package_claims (
 id UUID PRIMARY KEY,
 room_id UUID NOT NULL REFERENCES encryption_v2_mls_rooms(room_id) ON DELETE CASCADE,
 requester_device_id UUID NOT NULL REFERENCES encryption_v2_devices(id) ON DELETE CASCADE,
 target_device_id UUID NOT NULL REFERENCES encryption_v2_devices(id) ON DELETE CASCADE,
 package_id UUID NOT NULL UNIQUE REFERENCES encryption_v2_mls_packages(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 used_by UUID
);
CREATE TABLE encryption_v2_mls_events (
 id UUID PRIMARY KEY,
 room_id UUID NOT NULL REFERENCES encryption_v2_mls_rooms(room_id) ON DELETE CASCADE,
 sender_device_id UUID NOT NULL REFERENCES encryption_v2_devices(id),
 epoch BIGINT NOT NULL CHECK(epoch>=0),
 sequence BIGINT NOT NULL CHECK(sequence>0),
 kind TEXT NOT NULL CHECK(kind IN ('application','commit','welcome')),
 recipient_device_id UUID REFERENCES encryption_v2_devices(id),
 payload BYTEA NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 1048576),
 request_digest BYTEA NOT NULL CHECK(octet_length(request_digest)=32),
 transition_id UUID,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(room_id,sequence),
 CHECK((kind='welcome')=(recipient_device_id IS NOT NULL))
);
CREATE INDEX encryption_v2_mls_events_replay ON encryption_v2_mls_events(room_id,sequence);
-- All membership writers (including cascade/account/team paths) participate.
CREATE FUNCTION encryption_v2_membership_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid UUID;
BEGIN
 rid := CASE WHEN TG_OP='DELETE' THEN OLD.room_id ELSE NEW.room_id END;
 IF TG_OP='UPDATE' AND (NEW.room_id<>OLD.room_id OR NEW.user_id<>OLD.user_id)
 THEN RAISE EXCEPTION 'Replace membership identity using delete and insert' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM rooms WHERE id=rid FOR UPDATE;
 IF TG_OP='UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN RETURN NEW; END IF;
 UPDATE encryption_v2_mls_rooms SET roster_generation=roster_generation+1,
 removal_pending=removal_pending OR TG_OP='DELETE' WHERE room_id=rid;
 IF TG_OP='DELETE' THEN
  UPDATE encryption_v2_device_grants SET state='revoked' WHERE room_id=rid AND user_id=OLD.user_id;
  RETURN OLD;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER encryption_v2_membership_serialization BEFORE INSERT OR UPDATE OR DELETE ON room_members
 FOR EACH ROW EXECUTE FUNCTION encryption_v2_membership_fence();
-- Session revocation never grants an unapproved replacement device access.
CREATE FUNCTION encryption_v2_session_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revoked_at IS NOT NULL THEN
  UPDATE encryption_v2_devices SET revoked_at=COALESCE(revoked_at,NOW())
  WHERE id IN (SELECT device_id FROM encryption_v2_session_devices WHERE session_id=NEW.id);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER encryption_v2_session_revoked AFTER UPDATE OF revoked_at ON auth_sessions
 FOR EACH ROW EXECUTE FUNCTION encryption_v2_session_revoke();
