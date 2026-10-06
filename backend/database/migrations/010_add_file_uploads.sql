-- File upload provenance (BACKEND_TASKS.md item C).
--
-- The `attachments` table has always accepted a client-supplied `file_url`, which
-- means any room member could persist an arbitrary string as a file URL for
-- every other member to render. This table lets the server own the URL: a file
-- is uploaded once through POST /upload, which writes a row here, and a message
-- may only attach a URL that already exists in this table and was uploaded by
-- the sender.
--
-- `attached_message_id` enforces one-time use. It is NULL while the upload is
-- unclaimed and set to the message id once attached; the claim happens in the
-- same transaction as the message insert (see services/message.service.js), so a
-- failed send leaves the upload claimable. A conditional UPDATE ... WHERE
-- attached_message_id IS NULL takes a row lock, so two messages sent at the same
-- moment cannot both claim the same upload.
--
-- ON DELETE SET NULL rather than CASCADE: if a message is ever hard-deleted the
-- upload returns to the unclaimed pool instead of losing its provenance record.
-- Messages are soft-deleted, so this rarely fires.
--
-- Known gap: `mime_type` is recorded from the client-declared multipart
-- Content-Type, so a client can label an arbitrary file as an allowed type.
-- Cloudinary stores the real bytes, so nothing executable is served as an image,
-- but the stored type can be inaccurate. Fixing this properly needs magic-byte
-- sniffing (e.g. the `file-type` package), which is out of scope here.

CREATE TABLE IF NOT EXISTS file_uploads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_url            TEXT NOT NULL UNIQUE,
  filename            TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  size_bytes          INTEGER,
  attached_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Listing a user's recent uploads, and sweeping files nobody ever attached.
CREATE INDEX idx_file_uploads_uploader
  ON file_uploads (uploader_id, created_at DESC);

-- Partial index: "which uploads are still unclaimed?" stays cheap as the table
-- grows, which matters because claimed rows dominate once uploads are in use.
CREATE INDEX idx_file_uploads_unclaimed
  ON file_uploads (uploader_id)
  WHERE attached_message_id IS NULL;