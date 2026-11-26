ALTER TABLE file_uploads ADD COLUMN width INTEGER;
ALTER TABLE file_uploads ADD COLUMN height INTEGER;
ALTER TABLE file_uploads ADD COLUMN preview_url TEXT;
ALTER TABLE attachments ADD COLUMN width INTEGER;
ALTER TABLE attachments ADD COLUMN height INTEGER;
ALTER TABLE attachments ADD COLUMN preview_url TEXT;
