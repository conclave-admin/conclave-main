import IconAudio from '@/assets/icons/audio-file.svg?react';
import IconDocument from '@/assets/icons/document.svg?react';
import IconDownload from '@/assets/icons/download.svg?react';
import IconFile from '@/assets/icons/file.svg?react';
import IconImage from '@/assets/icons/image.svg?react';
import IconSpreadsheet from '@/assets/icons/spreadsheet.svg?react';

/**
 * A human-readable byte count.
 *
 * Binary units rather than decimal, because the server's 25MB cap is stated in
 * binary megabytes — showing "26.2 MB" for a file under the limit is the kind
 * of small lie that makes a limit look arbitrary.
 */
function formatSize(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function iconFor(mimeType = '') {
  if (mimeType.startsWith('image/')) return IconImage;
  if (mimeType.startsWith('audio/')) return IconAudio;
  if (mimeType.startsWith('video/')) return IconFile;
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return IconSpreadsheet;
  if (mimeType.startsWith('text/') || mimeType.includes('pdf') || mimeType.includes('document')) {
    return IconDocument;
  }
  return IconFile;
}

/**
 * One attachment on a message.
 *
 * The download is a plain link to the stored URL rather than a fetched blob:
 * these are Cloudinary assets with their own signed delivery, and routing them
 * through the client would add a proxy for no benefit while breaking the
 * browser's own handling of PDFs and images.
 *
 * `rel="noreferrer"` because the URL is user-supplied content. Without it a
 * hostile file host would receive the referrer of an authenticated app.
 *
 * @param {{ id?: string, filename: string, size?: number, mime_type?: string, url: string }} attachment
 */
export default function AttachmentCard({ attachment }) {
  const Icon = iconFor(attachment.mime_type);
  const size = formatSize(attachment.size);

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer noopener"
      download={attachment.filename}
      className="group flex w-full max-w-sm items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5 transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
    >
      <Icon className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-ink">{attachment.filename}</span>
        {size && <span className="block text-metadata text-muted">{size}</span>}
      </span>
      <IconDownload className="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-brand" aria-hidden="true" />
      <span className="sr-only">Download {attachment.filename}</span>
    </a>
  );
}
