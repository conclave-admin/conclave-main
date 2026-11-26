-- Public signed device statements only. No v1 keys or automatic enrollment.
CREATE TABLE encryption_v2_device_enrollments (
 id UUID PRIMARY KEY,
 device_id UUID NOT NULL UNIQUE REFERENCES encryption_v2_devices(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
 descriptor JSONB NOT NULL CHECK(octet_length(descriptor::text)<=8192),
 statement TEXT NOT NULL CHECK(octet_length(statement) BETWEEN 1 AND 32768),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '15 minutes'
);
CREATE TABLE encryption_v2_identity_roots (
 user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 device_id UUID NOT NULL UNIQUE REFERENCES encryption_v2_devices(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE encryption_v2_device_approvals (
 device_id UUID PRIMARY KEY REFERENCES encryption_v2_devices(id) ON DELETE CASCADE,
 issuer_device_id UUID NOT NULL REFERENCES encryption_v2_devices(id),
 statement TEXT NOT NULL CHECK(octet_length(statement) BETWEEN 1 AND 32768),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE encryption_v2_device_revocations (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id UUID NOT NULL UNIQUE REFERENCES encryption_v2_devices(id) ON DELETE CASCADE,
 issuer_device_id UUID NOT NULL REFERENCES encryption_v2_devices(id),
 statement TEXT NOT NULL CHECK(octet_length(statement) BETWEEN 1 AND 32768),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
