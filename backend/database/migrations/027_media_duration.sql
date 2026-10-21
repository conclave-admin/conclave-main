ALTER TABLE file_uploads ADD COLUMN duration DOUBLE PRECISION CHECK (duration > 0 AND duration <= 604800);
ALTER TABLE attachments ADD COLUMN duration DOUBLE PRECISION CHECK (duration > 0 AND duration <= 604800);
