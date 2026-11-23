// One transfer per immutable file, shared by chat, shared media and viewers.
// Byte storage and transport are injected for deterministic cancellation tests.
export function createMediaDownloads({ keyFor, read, fetchFile, cache }) {
  const records = new Map();
  let backgroundActive = 0;
  const backgroundQueue = [];
  function pumpBackground() {
    while (backgroundActive < 2 && backgroundQueue.length) {
      const job = backgroundQueue.shift();
      if (job.signal.aborted) {
        job.reject(new DOMException("Cancelled", "AbortError"));
        continue;
      }
      backgroundActive++;
      job.resolve(() => {
        backgroundActive--;
        pumpBackground();
      });
    }
  }
  function backgroundSlot(signal) {
    return new Promise((resolve, reject) => {
      backgroundQueue.push({ signal, resolve, reject });
      pumpBackground();
    });
  }

  const empty = () => ({
    status: "available",
    automatic: false,
    checking: true,
    progress: 0,
    blob: null,
    persisted: false,
    error: "",
  });
  function record(attachment) {
    const key = keyFor(attachment);
    if (!records.has(key))
      records.set(key, {
        key,
        attachment,
        state: empty(),
        listeners: new Set(),
        revision: 0,
      });
    const entry = records.get(key);
    entry.attachment = attachment;
    return entry;
  }
  function update(entry, updates) {
    entry.state = { ...entry.state, ...updates };
    entry.listeners.forEach((listener) => listener(entry.state));
  }
  async function check(entry) {
    const revision = ++entry.revision;
    const blob = await read(entry.attachment).catch(() => null);
    if (revision !== entry.revision || entry.flight) return;
    const available = entry.state.blob || blob;
    update(entry, {
      checking: false,
      status: available ? "downloaded" : "available",
      blob: available,
      persisted: Boolean(blob) && !entry.attachment.local_blob,
      error: "",
    });
  }
  function start(attachment, { automatic = false } = {}) {
    const entry = record(attachment);
    if (entry.flight) {
      if (!automatic) {
        entry.flight.automatic = false;
        update(entry, { automatic: false });
      }
      return entry.flight.promise;
    }
    // Opening/playing an already loaded file must not enter a transfer state.
    // Explicit cache invalidation and session changes clear this buffer.
    if (entry.state.blob) return Promise.resolve(entry.state.blob);
    const controller = new AbortController();
    const revision = ++entry.revision;
    update(entry, {
      status: "downloading",
      automatic,
      checking: false,
      progress: 0,
      error: "",
    });
    const promise = (async () => {
      try {
        const cached = await read(attachment);
        let blob = cached;
        if (!blob) {
          const release = automatic
            ? await backgroundSlot(controller.signal)
            : () => {};
          try {
            if (controller.signal.aborted)
              throw new DOMException("Cancelled", "AbortError");
            blob = await fetchFile(attachment, {
              signal: controller.signal,
              onProgress: (progress) => {
                if (!controller.signal.aborted) update(entry, { progress });
              },
            });
          } finally {
            release();
          }
        }
        if (controller.signal.aborted)
          throw new DOMException("Cancelled", "AbortError");
        const persisted = attachment.local_blob
          ? false
          : Boolean(cached) || (await cache(attachment, blob));
        if (controller.signal.aborted || revision !== entry.revision)
          throw new DOMException("Cancelled", "AbortError");
        update(entry, { status: "downloaded", blob, persisted, progress: 1 });
        return blob;
      } catch (error) {
        if (revision === entry.revision)
          update(entry, {
            status: controller.signal.aborted ? "available" : "failed",
            blob: null,
            persisted: false,
            error: controller.signal.aborted ? "" : error.message,
            progress: 0,
          });
        return null;
      } finally {
        if (entry.flight?.controller === controller) {
          entry.flight = null;
          if (!entry.listeners.size && records.get(entry.key) === entry)
            records.delete(entry.key);
        }
      }
    })();
    entry.flight = { controller, promise, automatic };
    return promise;
  }
  return {
    subscribe(attachment, listener) {
      const entry = record(attachment);
      entry.listeners.add(listener);
      listener(entry.state);
      if (!entry.flight) check(entry);
      return () => {
        entry.listeners.delete(listener);
        // StrictMode can resubscribe in the same turn. Release unused byte buffers.
        queueMicrotask(() => {
          if (!entry.listeners.size) {
            if (entry.flight?.automatic) return;
            entry.revision += 1;
            entry.flight?.controller.abort();
            if (records.get(entry.key) === entry) records.delete(entry.key);
          }
        });
      };
    },
    start,
    cancelAutomatic(predicate) {
      records.forEach((entry) => {
        if (entry.flight?.automatic && predicate(entry.attachment))
          entry.flight.controller.abort();
      });
    },
    cancel(attachment) {
      record(attachment).flight?.controller.abort();
    },
    recheck() {
      records.forEach((entry) => {
        if (!entry.flight) check(entry);
      });
    },
    invalidate(keys, accountPrefix) {
      records.forEach((entry) => {
        if (accountPrefix && !entry.key.startsWith(accountPrefix)) return;
        if (keys && !keys.includes(entry.key)) return;
        entry.revision += 1;
        entry.flight?.controller.abort();
        entry.flight = null;
        update(entry, { ...empty(), checking: false });
      });
    },
    stop() {
      records.forEach((entry) => {
        entry.revision += 1;
        entry.flight?.controller.abort();
        update(entry, empty());
      });
      records.clear();
    },
  };
}
