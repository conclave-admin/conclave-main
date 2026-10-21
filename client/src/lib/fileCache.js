/**
 * A local, bounded copy of attachment bytes.
 *
 * IndexedDB rather than localStorage. The two reasons are not decorative:
 * localStorage only stores strings, so every file would be base64'd and grow
 * by a third before it is stored, and it is synchronously limited to a few
 * megabytes per origin — one 25MB upload would fill it. IndexedDB stores
 * `Blob`s as they are, asynchronously, and does not have that ceiling.
 *
 * The key is the file's URL, not its attachment id. The same Cloudinary asset
 * can be reached through two ids (a message and its decision copy, for one),
 * and the URL is also the only key the sender has at upload time, before any
 * message row exists. One key, two callers, no reconciliation step.
 *
 * The store is capped by bytes, not by count: entries are `Blob`s of wildly
 * different sizes, so a record limit would let a handful of videos occupy the
 * whole budget. Eviction is least-recently-*used* rather than oldest-inserted —
 * `lastUsedAt` is touched on every read, so a conversation the user scrolls
 * past daily keeps its images while a month-old PDF falls out.
 *
 * Everything is best-effort. Private modes, storage pressure and quota errors
 * all degrade to "no cache", never to a failed render: a file the user can see
 * but not open is worse than one that re-downloads.
 */

const DB_NAME = "conclave-files";
const MAX_BYTES = 250 * 1024 * 1024;

// Blobs and their bookkeeping live in separate stores. Marking a file as
// recently used then rewrites a few bytes of metadata, not the whole file.
let dbPromise = null;
let cacheEpoch = 0;
const cacheChannel = typeof window !== 'undefined' && typeof BroadcastChannel === 'function'
  ? new BroadcastChannel('conclave-media-cache') : null;
cacheChannel?.addEventListener('message', (event) => {
  if (event.data === null) cacheEpoch += 1;
  window.dispatchEvent(new CustomEvent('conclave:media-cache-removed', { detail: { keys: event.data } }));
});
function cacheRemoved(keys = null) {
  cacheChannel?.postMessage(keys);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('conclave:media-cache-removed', { detail: { keys } }));
}

function open() {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("IndexedDB unavailable"));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "key" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        if (!db.objectStoreNames.contains("roomMessages")) db.createObjectStore("roomMessages", { keyPath: "key" });
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "key" });
        if (!db.objectStoreNames.contains("roomMetadata")) db.createObjectStore("roomMetadata", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  }
  return dbPromise;
}

function transact(stores, mode, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(stores, mode);
        let out;
        transaction.oncomplete = () =>
          resolve(out && "result" in out ? out.result : out);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        try { out = work(transaction); }
        catch (error) {
          // Synchronous failures must roll back earlier writes in the batch too.
          transaction.abort();
          reject(error);
        }
      }),
  );
}

let persistAsked = false;
function askToPersist() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

/** The stored file for this key, or null. Never throws: the cache is best effort. */
export async function readLocalFile(key) {
  if (!key) return null;
  try {
    const record = await transact(["files"], "readonly", (t) =>
      t.objectStore("files").get(key),
    );
    if (!record) return null;

    // Touch so eviction drops what is untouched, not what is popular.
    transact(["meta"], "readwrite", (t) => {
      const store = t.objectStore("meta");
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result)
          store.put({ ...request.result, lastUsed: Date.now() });
      };
    }).catch(() => {});

    return record.blob;
  } catch {
    return null;
  }
}

/** Store a file. Resolves once it is written, and swallows quota errors. */
export async function saveLocalFile(key, blob, info = {}) {
  if (!key || !blob) return false;
  const epoch = cacheEpoch;
  try {
    askToPersist();
    await transact(["files", "meta"], "readwrite", (t) => {
      if (epoch !== cacheEpoch) throw new Error("Cache cleared");
      t.objectStore("files").put({ key, blob });
      t.objectStore("meta").put({
        key,
        size: blob.size,
        filename: info.filename || null,
        mime: info.mime || blob.type || null,
        lastUsed: Date.now(),
      });
    });
    await trim();
    return epoch === cacheEpoch && Boolean(await readLocalFile(key));
  } catch {
    return false;
  }
}

async function trim(maxBytes = MAX_BYTES) {
  const all = await transact(["meta"], "readonly", (t) =>
    t.objectStore("meta").getAll(),
  );
  let total = all.reduce((sum, entry) => sum + (entry.size || 0), 0);
  if (total <= maxBytes) return;

  const oldestFirst = [...all].sort((a, b) => a.lastUsed - b.lastUsed);
  const drop = [];
  for (const entry of oldestFirst) {
    if (total <= maxBytes) break;
    drop.push(entry.key);
    total -= entry.size || 0;
  }

  await transact(["files", "meta"], "readwrite", (t) => {
    drop.forEach((key) => {
      t.objectStore("files").delete(key);
      t.objectStore("meta").delete(key);
    });
  });
  cacheRemoved(drop);
}

export async function localFileUsage() {
  try {
    const all = await transact(["meta"], "readonly", (t) =>
      t.objectStore("meta").getAll(),
    );
    return all.reduce((sum, entry) => sum + (entry.size || 0), 0);
  } catch {
    return 0;
  }
}

/** For logout and for a "clear downloaded media" button in Settings. */
export async function clearLocalFiles() {
  cacheEpoch += 1;
  try {
    await transact(["files", "meta"], "readwrite", (t) => {
      t.objectStore("files").clear();
      t.objectStore("meta").clear();
    });
    cacheRemoved();
  } catch {
    // Nothing stored, or storage unavailable.
  }
}

export async function clearLocalData() {
  cacheEpoch += 1;
  try {
    await transact(["files", "meta", "roomMessages", "outbox", "roomMetadata"], "readwrite", (t) => {
      t.objectStore("files").clear();
      t.objectStore("meta").clear();
      t.objectStore("roomMessages").clear();
      t.objectStore("outbox").clear();
      t.objectStore("roomMetadata").clear();
    });
    cacheRemoved();
  } catch { /* local state is already unavailable */ }
}

export async function readRoomMessages(userId, roomId) {
  if (!userId || !roomId) return [];
  try {
    return (await transact(["roomMessages"], "readonly", (t) =>
      t.objectStore("roomMessages").get(`${userId}:${roomId}`),
    ))?.messages || [];
  } catch { return []; }
}

export async function readRoomMetadata(userId, roomId) {
  if (!userId || !roomId) return null;
  try {
    return (await transact(['roomMetadata'], 'readonly', (t) =>
      t.objectStore('roomMetadata').get(`${userId}:${roomId}`)))?.room || null;
  } catch { return null; }
}

export async function readChatList(userId) {
  if (!userId) return [];
  try {
    return (await transact(['roomMetadata'], 'readonly', (t) =>
      t.objectStore('roomMetadata').get(`chats:${userId}`)))?.rooms || [];
  } catch { return []; }
}

export async function saveChatList(userId, rooms) {
  if (!userId) return;
  try {
    await transact(['roomMetadata'], 'readwrite', (t) =>
      t.objectStore('roomMetadata').put({ key: `chats:${userId}`, rooms }));
  } catch { /* The last-known chat list is a cache, independent of the outbox. */ }
}

export async function saveRoomMetadata(userId, roomId, room) {
  if (!userId || !roomId) return;
  try {
    await transact(['roomMetadata'], 'readwrite', (t) => room
      ? t.objectStore('roomMetadata').put({ key: `${userId}:${roomId}`, room })
      : t.objectStore('roomMetadata').delete(`${userId}:${roomId}`));
  } catch { /* Room metadata is a cache; the outbox is stored separately. */ }
}

export async function saveRoomMessages(userId, roomId, messages) {
  if (!userId || !roomId) return;
  try {
    await transact(["roomMessages"], "readwrite", (t) => t.objectStore("roomMessages").put({
      // Pending files belong to the durable outbox, never the evictable history.
      key: `${userId}:${roomId}`, messages: messages.filter((message) => !message._optimistic).slice(-200), savedAt: Date.now(),
    }));
  } catch { /* local history is a best-effort cache */ }
}

export async function listOutbox(userId, roomId) {
  if (!userId) return [];
  const rows = await transact(["outbox"], "readonly", (t) => t.objectStore("outbox").getAll());
  return rows
    .filter((row) => row.userId === userId && (!roomId || row.roomId === roomId))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function putOutbox(item) {
  await putOutboxBatch([item]);
}

/** Commit the entire batch, including Blobs, before allowing any upload. */
export async function putOutboxBatch(items) {
  if (!items.length || items.some((item) => !item?.key || !item.userId)) throw new Error('Invalid message draft');
  await transact(["outbox"], "readwrite", (t) => {
    const store = t.objectStore("outbox");
    items.forEach((item) => store.add(item));
  });
  askToPersist();
}

/** Checkpoints cannot resurrect a cancelled draft or a cleared account. */
export async function updateOutbox(item) {
  return transact(["outbox"], "readwrite", (t) => {
    const result = { result: false };
    const store = t.objectStore("outbox");
    const request = store.get(item.key);
    request.onsuccess = () => {
      if (request.result?.userId !== item.userId) return;
      store.put(item);
      result.result = true;
    };
    return result;
  });
}

/** Once delivery was attempted, its outcome must be resolved using clientId. */
export async function cancelOutbox(key) {
  return transact(["outbox"], "readwrite", (t) => {
    const result = { result: false };
    const store = t.objectStore("outbox");
    const request = store.get(key);
    request.onsuccess = () => {
      if (!request.result || request.result.sendAttempted) return;
      store.delete(key);
      result.result = true;
    };
    return result;
  });
}

export async function deleteOutbox(key) {
  await transact(["outbox"], "readwrite", (t) => t.objectStore("outbox").delete(key));
}

/** Partial originals use the same bounded, evictable byte cache as full media. */
export async function removeLocalFile(key) {
  try {
    await transact(['files','meta'], 'readwrite', (t) => { t.objectStore('files').delete(key); t.objectStore('meta').delete(key); });
    cacheRemoved([key]);
  } catch { /* Best effort. */ }
}
