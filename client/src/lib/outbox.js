// Persistent upload/delivery state machine. Network and storage are injected so
// interrupted uploads, lost acknowledgements and cancellation can be exercised
// without a live bucket. Blobs never enter a socket payload.
export function createClientId() {
  return globalThis.crypto.randomUUID();
}

export function draftMessage(item, senderName = "You") {
  const attachment = item.payload.attachments?.[0];
  return {
    id: item.tempId,
    client_id: item.clientId,
    room_id: item.roomId,
    sender_id: item.userId,
    sender_name: senderName,
    content: item.payload.content || "",
    reply_to_id: item.payload.replyToId || null,
    album_id: item.payload.albumId || null,
    forwarded: Boolean(item.payload.forwardSource),
    attachments: item.media
      ? [
          {
            ...attachment,
            ...item.media.metadata,
            filename: item.media.filename,
            mime_type: item.media.blob.type,
            size: item.media.blob.size,
            url: attachment?.url || `local:${item.key}`,
            local_blob: item.media.blob,
          },
        ]
      : item.forwardPreview || item.payload.attachments || [],
    mentioned_user_ids: item.payload.mentionedUserIds || [],
    reactions: [],
    created_at: new Date(item.createdAt).toISOString(),
    _optimistic: true,
    _outbox: {
      key: item.key,
      state: item.state,
      progress: item.progress || 0,
      error: item.error || "",
      retryAt: item.retryAt || 0,
      canCancel: !item.sendAttempted,
      media: Boolean(item.media),
    },
  };
}

export function createOutbox({
  userId,
  store,
  upload,
  prepare,
  prepareMetadata,
  prepareEncryption,
  prepareSend,
  cancelUpload,
  remember,
  send,
  canSend,
  onChange,
  onSent,
  onError = () => {},
  changed = () => {},
  withLock = (work) => work(),
  now = Date.now,
  retryDelay = 1000,
}) {
  let entries = [];
  let stopped = false;
  let running = false;
  let timer;
  let flight;
  let ready;
  const unsaved = new Map();
  let mutation = Promise.resolve();
  const serial = (work) => {
    const result = mutation.then(work);
    mutation = result.catch(() => {});
    return result;
  };
  const publish = () => {
    if (!stopped) onChange([...entries]);
  };
  const replace = (item) => {
    entries = entries.map((entry) => (entry.key === item.key ? item : entry));
    publish();
  };
  const checkpoint = async (item) => {
    if (stopped || flight?.controller.signal.aborted)
      throw new DOMException("Interrupted", "AbortError");
    if (!(await store.update(item)))
      throw new DOMException("Draft removed", "AbortError");
    unsaved.delete(item.key);
    if (stopped) throw new DOMException("Interrupted", "AbortError");
    replace(item);
    changed();
  };
  const refresh = async () => {
    const rows = await store.list(userId);
    if (!stopped) {
      entries = rows.map(
        (item) =>
          unsaved.get(item.key) || {
            ...item,
            state: item.uploadRetryBlocked && item.media && !item.payload.attachments?.length
              ? "failed" : item.state || "queued",
            // Older outbox records may already have been emitted before refresh.
            sendAttempted: item.sendAttempted ?? true,
          },
      );
      if (flight && !entries.some((item) => item.key === flight.key))
        flight.controller.abort();
      publish();
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (stopped || !canSend()) return;
    const pending = entries.filter(
      (item) => item.state !== "failed",
    );
    if (pending.length) {
      const delay = Math.max(
        250,
        Math.min(...pending.map((item) => (item.retryAt || 0) - now())),
      );
      timer = setTimeout(wake, delay);
    }
  };

  async function process(item) {
    const controller = new AbortController();
    flight = { key: item.key, controller };
    try {
      if (item.media && !item.payload.attachments?.length) {
        item = {
          ...item,
          state: "uploading",
          error: "",
          retryAt: 0,
          uploadRetryBlocked: false,
        };
        await checkpoint(item);
        if (item.media.compress) {
          const blob = await prepare(item.media.blob, item.media.filename);
          item = {
            ...item,
            media: {
              ...item.media,
              blob,
              filename: blob.name || item.media.filename,
              compress: false,
            },
          };
          await checkpoint(item);
        }
        if (prepareMetadata && !item.media.metadataPrepared) {
          const metadata = await prepareMetadata(
            item.media.blob,
            controller.signal,
          );
          item = {
            ...item,
            media: { ...item.media, metadata, metadataPrepared: true },
          };
          await checkpoint(item);
        }
        if(prepareEncryption&&!item.media.encrypted){item=await prepareEncryption(item);await checkpoint(item);}
        const attachment = await upload(item.media.uploadBlob||item.media.blob, {
          roomId: item.roomId, clientId: item.clientId, session: item.media.session,
          onCheckpoint: async (session) => {
            item = { ...item, media: { ...item.media, session } };
            await checkpoint(item);
          },
          metadata: item.media.encrypted?{}:item.media.metadata,
          filename: item.media.encrypted?'encrypted.bin':item.media.filename,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!stopped && !controller.signal.aborted)
              replace({ ...item, progress });
          },
        });
        if (!attachment?.url)
          throw new Error("The upload returned no file reference.");
        // Save the successful upload BEFORE emitting anything. A lost ack must
        // retry this claim with the same clientId, never upload the file again.
        item = {
          ...item,
          payload: { ...item.payload, attachments: [attachment] },
          state: "queued",
          progress: 1,
        };
        await checkpoint(item);
      }
      if (item.media && item.payload.attachments?.[0]) {
        await remember(item.payload.attachments[0].url, item.media.blob,{encrypted:item.media.encrypted});
      }
      if (!canSend() || controller.signal.aborted || stopped)
        throw new DOMException("Offline", "AbortError");
      if(prepareSend&&!item.wirePayload){
        item={...item,wirePayload:await prepareSend(item.payload,item.media)};
        await checkpoint(item);
      }
      item = {
        ...item,
        state: "awaiting_ack",
        sendAttempted: true,
        error: "",
        retryAt: 0,
      };
      await checkpoint(item);
      const message = await send(item.wirePayload||item.payload, controller.signal,item);
      if (stopped || controller.signal.aborted) return;
      await store.remove(item.key);
      unsaved.delete(item.key);
      if (stopped) return;
      entries = entries.filter((entry) => entry.key !== item.key);
      // Notify history before publishing removal, avoiding a blank bubble.
      try {
        onSent(message, item);
      } catch (error) {
        onError(error);
      }
      publish();
      changed();
    } catch (error) {
      if (stopped) return;
      const current = entries.find((entry) => entry.key === item.key);
      if (!current) return;
      const interrupted =
        error.name === "AbortError" ||
        error.code === "ERR_CANCELED" ||
        !canSend();
      const attempts = interrupted
        ? item.attempts || 0
        : (item.attempts || 0) + 1;
      const status = error.response?.status || error.status;
      const retiredUpload = Boolean(item.media && item.payload.attachments?.length && status === 400
        && /Attachment is unavailable/.test(error.message || error.response?.data?.message || ''));
      if (retiredUpload) item = { ...item, wirePayload:undefined,payload: { ...item.payload, attachments: [] }, sendAttempted: false };
      if(status===409&&error.definitive&&/Encryption recipients changed/.test(error.message||''))item={...item,wirePayload:undefined,sendAttempted:false};
      const retryable =
        !error.permanent &&
        (!status || status >= 500 || [408, 429].includes(status));
      const uploadFailed = Boolean(item.media && !item.payload.attachments?.length);
      const failed = uploadFailed || (!interrupted && (!retryable || attempts >= 5));
      const retryAfter = Number(error.response?.headers?.["retry-after"]);
      const delay =
        status === 429
          ? retryAfter > 0
            ? retryAfter * 1000
            : 60000
          : Math.min(30000, retryDelay * 2 ** (attempts - 1));
      item = {
        ...item,
        state: failed ? "failed" : "queued",
        attempts,
        uploadRetryBlocked: false,
        sendAttempted: error.definitive ? false : item.sendAttempted,
        error: retiredUpload ? "This upload expired before the message was sent. Retry to upload the saved file again." : uploadFailed
          ? interrupted ? "Upload interrupted because the connection was lost. Reconnect, then retry."
            : status === 429 ? `Upload limit reached. Wait ${Math.ceil(delay / 1000)} seconds before retrying.`
            : error.response?.data?.message || (status >= 500
              ? "The upload server is temporarily unavailable. Please retry."
              : error.code === "ERR_NETWORK" ? "The upload server could not be reached. Check your connection and retry."
              : error.message) || "Upload failed. Check your connection and retry."
          : interrupted ? "" : error.response?.data?.message || error.message || "Could not send this message.",
        retryNotBefore: uploadFailed && status === 429 ? now() + delay : 0,
        retryAt: interrupted || failed ? 0 : now() + delay,
      };
      try {
        if (await store.update(item)) {
          unsaved.delete(item.key);
          replace(item);
          changed();
        } else {
          entries = entries.filter((entry) => entry.key !== item.key);
          publish();
        }
      } catch {
        // Keep the Blob and successful upload in memory too. Do not send until
        // the checkpoint can be saved; the error remains visible in the bubble.
        const blocked = {
          ...item,
          state: "failed",
          error:
            "Could not save send progress on this device. Free storage and retry.",
        };
        unsaved.set(item.key, blocked);
        replace(blocked);
      }
    } finally {
      flight = null;
    }
  }

  async function wake() {
    if (running || stopped || !canSend()) return;
    running = true;
    clearTimeout(timer);
    try {
      await ready;
      await withLock(async () => {
        // Another tab may have sent or cancelled a draft while this one waited.
        await serial(refresh);
        while (!stopped && canSend()) {
          const item = entries.find(
            (entry) =>
              entry.state !== "failed" &&
              (!entry.retryAt || entry.retryAt <= now()),
          );
          if (!item) break;
          await process(item);
        }
      });
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      running = false;
      schedule();
    }
  }

  return {
    start() {
      ready = refresh();
      ready.then(wake).catch(onError);
      return ready;
    },
    wake,
    refresh: () => serial(refresh),
    pause() {
      flight?.controller.abort();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      flight?.controller.abort();
      entries = [];
      unsaved.clear();
    },
    enqueue(items) {
      return serial(async () => {
        await ready;
        if (stopped)
          throw new Error("Your session changed. Please sign in again.");
        await store.add(items);
        if (stopped)
          throw new Error("Your session changed. Please sign in again.");
        entries = [...entries, ...items];
        publish();
        changed();
        wake();
      });
    },
    retry(key) {
      return serial(async () => {
        const item = entries.find((entry) => entry.key === key);
        if (!item || flight?.key === key || stopped) return;
        if (item.retryNotBefore > now()) throw new Error(`Upload limit reached. Retry in ${Math.ceil((item.retryNotBefore - now()) / 1000)} seconds.`);
        const next = {
          ...item,
          state: "queued",
          error: "",
          attempts: 0,
          retryAt: 0,
          uploadRetryBlocked: false,
        };
        if (!(await store.update(next))) return;
        unsaved.delete(key);
        replace(next);
        changed();
        wake();
      });
    },
    cancel(key) {
      return serial(async () => {
        if (stopped) return;
        const item = entries.find((entry) => entry.key === key);
        if (!(await store.cancel(key)))
          throw new Error(
            "Delivery has already started. Wait for the send result.",
          );
        if (flight?.key === key) flight.controller.abort();
        unsaved.delete(key);
        entries = entries.filter((entry) => entry.key !== key);
        publish();
        changed();
        // The server also sweeps expired sessions if this best-effort abort is offline.
        if (item?.media?.session) cancelUpload?.(item.media.session).catch(onError);
      });
    },
  };
}
