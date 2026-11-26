-- Some databases recorded the E2EE removal while also losing this lifecycle
-- column. Applied migrations are not replayed, so repair those schemas forward.
-- Preserve existing supersession links on databases that already have it.
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES rooms(id);
