import { api } from '../lib/api';
import { downloadInChunks, DOWNLOAD_CHUNK_SIZE } from '../lib/resumableDownload';
import { readLocalFile, saveLocalFile, removeLocalFile } from '../lib/fileCache';
import { getSessionUserId } from '../lib/session';
import { isDevAuthBypass } from '../config/devPreview';

export const attachmentAccount = () => getSessionUserId() || (isDevAuthBypass ? 'preview' : 'signed-out');
export const attachmentCacheKey = (attachment, preview = false) =>
  `media:${attachmentAccount()}:${preview ? 'preview-v1:' : ''}${attachment.url || attachment.id}`;

async function readError(error) {
  const data = error.response?.data;
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text()).message; } catch { return null; }
  }
  return data?.message || null;
}

// Cancellation belongs to the download controller, not a shared Axios promise:
// cancelling one request must not leave another bubble waiting on stale state.
export async function getAttachmentBlob(attachment, { onProgress, signal } = {}) {
  if (attachment.local_blob) return attachment.local_blob;
  const cached = await getCachedAttachmentBlob(attachment);
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (cached) return cached;
  if (!attachment.id) throw new Error('This file is not available yet.');
  try {
    return await downloadInChunks(attachment, { signal, onProgress }, {
      key: attachmentCacheKey, read: readLocalFile, save: saveLocalFile,
      clearParts: async (key, size) => {
        for (let start=0; start<size; start+=DOWNLOAD_CHUNK_SIZE) await removeLocalFile(`${key}:part:${start}`);
      },
    }, async ({ start, end, etag, signal: requestSignal, onProgress: progress }) => {
      const headers = start !== undefined ? { Range: `bytes=${start}-${end}`, ...(etag ? { 'If-Range': etag } : {}) } : {};
      const response = await api.get(`/attachments/${attachment.id}`, {
        responseType: 'blob', signal: requestSignal, headers,
        onDownloadProgress: (event) => { if (event.total) progress?.(event.loaded/event.total); },
      });
      if (response.status === 206 && response.headers['content-range'] !== `bytes ${start}-${end}/${attachment.size}`) throw new Error('The file server returned an invalid range.');
      return { blob: response.data, etag: response.headers.etag, full: response.status === 200 };
    });
  } catch (error) {
    if (signal?.aborted || error.code === 'ERR_CANCELED') throw new DOMException('Cancelled', 'AbortError');
    throw new Error((await readError(error)) || 'Could not load this file. Check your connection and retry.');
  }
}

export function getCachedAttachmentBlob(attachment) {
  if (attachment.local_blob) return Promise.resolve(attachment.local_blob);
  return readLocalFile(attachmentCacheKey(attachment));
}

export async function cacheAttachmentBlob(attachment, blob) {
  const saved = await saveLocalFile(attachmentCacheKey(attachment), blob, { filename: attachment.filename, mime: attachment.mime_type });
  for (let start=0; start<Number(attachment.size || blob.size); start+=DOWNLOAD_CHUNK_SIZE) await removeLocalFile(`${attachmentCacheKey(attachment)}:part:${start}`);
  return saved;
}

export async function getAttachmentStreamUrl(attachment) {
  const { data } = await api.get(`/attachments/${attachment.id}/url`);
  return data.data;
}
export async function getAttachmentPreviewUrl(attachment, { signal } = {}) {
  const { data } = await api.get(`/attachments/${attachment.id}/preview-url`, { signal });
  return data.data;
}

// Token URLs are never cache keys. Cache the bytes by account and immutable file.
export async function getAttachmentPreviewBlob(attachment, { signal } = {}) {
  const key = attachmentCacheKey(attachment, true);
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const cached = await readLocalFile(key);
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (cached) return cached;
  const account = attachmentAccount();
  if (attachment.preview_url?.startsWith('data:image/jpeg;base64,')) {
    const response = await fetch(attachment.preview_url, { signal });
    const blob = await response.blob();
    if (blob.size <= 12288 && account === attachmentAccount() && !signal?.aborted) await saveLocalFile(key, blob);
    return blob;
  }
  if (!attachment.id) throw new Error('Preview unavailable.');
  const preview = await getAttachmentPreviewUrl(attachment, { signal });
  if (!preview.url) throw new Error('No preview available. Open to download the original.');
  const response = await fetch(preview.url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error('Preview could not load. Retry for a fresh link.');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/') || blob.size > 1024 * 1024) throw new Error('Invalid image preview.');
  if (account === attachmentAccount() && !signal?.aborted) await saveLocalFile(key, blob);
  return blob;
}

export function rememberUploadedFile(url, file) {
  return cacheAttachmentBlob({ url, filename: file.name, mime_type: file.type }, file);
}

export function saveAttachmentToDevice(attachment, blob) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl; link.download = attachment.filename || 'download';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}
export async function downloadAttachment(attachment) {
  const blob = await getAttachmentBlob(attachment);
  await cacheAttachmentBlob(attachment, blob);
  saveAttachmentToDevice(attachment, blob);
}
