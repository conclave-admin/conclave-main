export const DOWNLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
// Completed bounded chunks survive cancellation, reload and connection loss.
export async function downloadInChunks(attachment, { signal, onProgress } = {}, storage, request) {
  const key = storage.key(attachment);
  const size = Number(attachment.size);
  const active = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  if (!Number.isSafeInteger(size) || size <= 0) return (await request({ signal })).blob;
  const chunks = []; let etag; let cacheable = true;
  for (let start = 0; start < size; start += DOWNLOAD_CHUNK_SIZE) {
    active();
    const end = Math.min(size-1, start+DOWNLOAD_CHUNK_SIZE-1);
    const chunkKey = `${key}:part:${start}`;
    const saved = await storage.read(chunkKey);
    // Each chunk includes its representation validator so a changed legacy file
    // can never be combined with bytes from a previous version.
    let result;
    if (saved) {
      try {
        const headerSize = new DataView(await saved.slice(0,4).arrayBuffer()).getUint32(0);
        const validator = await saved.slice(4,4+headerSize).text();
        const blob = saved.slice(4+headerSize);
        if (headerSize < 1024 && blob.size === end-start+1 && (!etag || etag === validator)) result = { blob, etag: validator };
      } catch { /* Corrupt/evicted chunks fall through to authenticated delivery. */ }
    }
    if (!result) {
      result = await request({ start, end, etag, signal, onProgress: (fraction) => onProgress?.((start+fraction*(end-start+1))/size) });
      active();
      if (result.full) { await storage.clearParts(key, size); return result.blob; }
      if (result.blob.size !== end-start+1) throw new Error('The server returned an incomplete download chunk. Retry to resume.');
      if (etag && result.etag && result.etag !== etag) {
        await storage.clearParts(key, size); throw new Error('This file changed during download. Retry to start with the current version.');
      }
      if (result.etag && cacheable) {
        const header = new TextEncoder().encode(result.etag); const length = new ArrayBuffer(4); new DataView(length).setUint32(0,header.length);
        cacheable = await storage.save(chunkKey, new Blob([length, header, result.blob]));
      }
    }
    etag ||= result.etag;
    chunks.push(result.blob); onProgress?.((end+1)/size);
  }
  active();
  return new Blob(chunks, { type: attachment.mime_type || 'application/octet-stream' });
}
