-- Each fresh MLS admission replaces the grant identity, not old sending state.
ALTER TABLE encryption_v2_device_grants
 ADD COLUMN admission_id UUID NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN welcome_id UUID REFERENCES encryption_v2_mls_events(id),
 ADD COLUMN pending_expires_at TIMESTAMPTZ;
CREATE UNIQUE INDEX encryption_v2_admission_id_unique
 ON encryption_v2_device_grants(admission_id);
-- Earlier experimental pending grants lack lifetime provenance. Fail closed;
-- a maintained-library Remove followed by a fresh Add is required.
UPDATE encryption_v2_device_grants SET pending_expires_at=NOW()
 WHERE state='pending';
