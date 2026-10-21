// The API authorizes and completes uploads; only part bytes go directly to R2.
// Session and part checkpoints belong to the durable outbox, not component state.
export async function transferMultipart(blob, options, transport) {
  const { filename, metadata, roomId, clientId, signal, onProgress, onCheckpoint } = options;
  const assertActive = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  assertActive();
  let session;
  if (options.session?.id) {
    try { session = await transport.get(options.session.id, signal); }
    catch (error) { if (![404,410].includes(error.response?.status || error.status)) throw error; }
  }
  if (!session) session = await transport.create({ filename, mime_type: blob.type, size: blob.size, metadata, roomId, clientId,
    restart: Boolean(options.session?.id) }, signal);
  assertActive();
  await onCheckpoint({ id: session.id, parts: session.parts || [] });
  if (session.attachment) return session.attachment;
  if (session.readyToFinalize) return transport.complete(session.id, signal);
  const partSize = session.partSize;
  if (!Number.isInteger(partSize) || partSize < 5*1024*1024) throw new Error('The upload server returned an invalid part size.');
  const completed = new Map((session.parts || []).map((part) => [part.partNumber, part]));
  const total = Math.ceil(blob.size / partSize);
  for (let partNumber = 1; partNumber <= total; partNumber++) {
    assertActive();
    const start = (partNumber-1)*partSize;
    const part = blob.slice(start, Math.min(blob.size, start+partSize));
    const saved = completed.get(partNumber);
    if (saved?.size === part.size && saved.etag) { onProgress?.(Math.min(1,(start+part.size)/blob.size)); continue; }
    const authorization = await transport.sign(session.id, partNumber, signal);
    assertActive();
    const etag = await transport.put(authorization.url, part, { signal,
      onProgress: (fraction) => onProgress?.(Math.min(1,(start+fraction*part.size)/blob.size)) });
    if (!etag) throw new Error('R2 did not expose ETag. Check the bucket CORS configuration, then retry.');
    assertActive();
    completed.set(partNumber, { partNumber, etag, size: part.size });
    await onCheckpoint({ id: session.id, parts: [...completed.values()] });
    onProgress?.(Math.min(1,(start+part.size)/blob.size));
  }
  assertActive();
  return transport.complete(session.id, signal);
}
