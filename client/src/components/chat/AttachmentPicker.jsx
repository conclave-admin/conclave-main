import { useRef } from 'react';
import IconAttach from '@/assets/icons/attach.svg?react';

// Mirrors the server's multer limit in upload.routes.js and MAX_UPLOAD_BYTES in
// upload.controller.js. Stated here so the rejection happens before a 25MB
// request is put on the wire, and so the message names the real bound rather
// than echoing whatever the server happened to say.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/**
 * The composer's attach button.
 *
 * Validation happens here, before the upload: type against the server's
 * allowlist, size against the 25MB cap, count against the 10-file maximum.
 * Each is a case the server would also reject, but rejecting locally turns a
 * multi-second failed round trip into an immediate, specific message.
 *
 * Video is not in the allowlist because the server excludes it deliberately —
 * a 25MB ceiling is a poor limit for video, so it is held back rather than
 * half-supported. Offering it here would be a guaranteed 415.
 *
 * @param {(files: File[]) => void} onFiles - already validated
 * @param {boolean} disabled
 */
export default function AttachmentPicker({ onFiles, disabled }) {
  const inputRef = useRef(null);

  const ACCEPTED = [
    'image/*',
    'application/pdf',
    'text/*',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
    'application/gzip',
    'audio/*',
  ].join(',');

  const handleChange = (event) => {
    const files = [...(event.target.files || [])];
    // Reset so re-picking the same file after a rejection fires change again.
    event.target.value = '';
    if (files.length === 0) return;
    onFiles(files);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED}
        onChange={handleChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        aria-label="Attach file"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40"
      >
        <IconAttach className="h-5 w-5" aria-hidden="true" />
      </button>
    </>
  );
}
