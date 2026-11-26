import test from "node:test";
import assert from "node:assert/strict";
import { transferMultipart } from "../src/lib/multipartUpload.js";
import {
  downloadInChunks,
  DOWNLOAD_CHUNK_SIZE as CHUNK,
} from "../src/lib/resumableDownload.js";
import { groupMediaAlbums, viewerItems } from "../src/lib/mediaAlbums.js";
const PART = 8 * 1024 * 1024;
test("multipart resume reuses server parts and checkpoints before more bytes are sent", async () => {
  const blob = new Blob([new Uint8Array(PART + 10)], {
    type: "application/pdf",
  });
  const checkpoints = [];
  const puts = [];
  const progress = [];
  const attachment = { url: "r2://private/final" };
  const result = await transferMultipart(
    blob,
    {
      session: { id: "session" },
      onProgress: (v) => progress.push(v),
      onCheckpoint: async (session) =>
        checkpoints.push(structuredClone(session)),
    },
    {
      get: async () => ({
        id: "session",
        partSize: PART,
        parts: [{ partNumber: 1, size: PART, etag: "first" }],
      }),
      sign: async (id, number) => {
        assert.equal(checkpoints.length, 1);
        assert.equal(number, 2);
        return { url: "signed-part-2" };
      },
      put: async (url, chunk) => {
        puts.push(url);
        assert.equal(chunk.size, 10);
        return "second";
      },
      complete: async () => {
        assert.equal(checkpoints.at(-1).parts.length, 2);
        return attachment;
      },
    },
  );
  assert.equal(result, attachment);
  assert.deepEqual(puts, ["signed-part-2"]);
  assert.equal(progress.at(-1), 1);
});
test("a completed multipart upload is reused after a lost finalization response", async () => {
  const attachment = { url: "r2://private/already-finished" };
  let sent = false;
  const result = await transferMultipart(
    new Blob(["file"]),
    { session: { id: "s" }, onCheckpoint: async () => {} },
    {
      get: async () => ({ id: "s", attachment }),
      put: () => {
        sent = true;
      },
    },
  );
  assert.equal(result, attachment);
  assert.equal(sent, false);
});
test("cancelled multipart uploads cannot finalize or checkpoint late parts", async () => {
  const controller = new AbortController();
  let finished = false;
  await assert.rejects(
    transferMultipart(
      new Blob(["file"]),
      { signal: controller.signal, onCheckpoint: async () => {} },
      {
        create: async () => ({ id: "s", partSize: PART, parts: [] }),
        sign: async () => ({ url: "signed" }),
        put: async () => {
          controller.abort();
          return "late";
        },
        complete: async () => {
          finished = true;
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(finished, false);
});
test("missing exposed ETag is actionable and never finalizes", async () => {
  await assert.rejects(
    transferMultipart(
      new Blob(["file"]),
      { onCheckpoint: async () => {} },
      {
        create: async () => ({ id: "s", partSize: PART }),
        sign: async () => ({ url: "signed" }),
        put: async () => null,
      },
    ),
    /CORS/,
  );
});
function storage() {
  const rows = new Map();
  return {
    rows,
    key: () => "file",
    read: async (key) => rows.get(key),
    save: async (key, blob) => {
      rows.set(key, blob);
      return true;
    },
    clearParts: async () => {
      rows.clear();
    },
  };
}
test("download resumes retained chunks after interruption without mixing representations", async () => {
  const store = storage();
  const file = { size: CHUNK + 4, mime_type: "application/pdf" };
  const requests = [];
  let fail = true;
  const request = async ({ start, end }) => {
    requests.push(start);
    if (start && fail) throw new Error("Offline");
    return {
      blob: new Blob([new Uint8Array(end - start + 1)]),
      etag: "immutable-v1",
    };
  };
  await assert.rejects(downloadInChunks(file, {}, store, request), /Offline/);
  assert.equal(store.rows.size, 1);
  fail = false;
  const result = await downloadInChunks(file, {}, store, request);
  assert.deepEqual(requests, [0, CHUNK, CHUNK]);
  assert.equal(result.size, CHUNK + 4);
});
test("a changed ETag clears saved chunks and requires a clean retry", async () => {
  const store = storage();
  await assert.rejects(
    downloadInChunks(
      { size: CHUNK + 1 },
      {},
      store,
      async ({ start, end }) => ({
        blob: new Blob([new Uint8Array(end - start + 1)]),
        etag: start ? "v2" : "v1",
      }),
    ),
    /changed/,
  );
  assert.equal(store.rows.size, 0);
});
test("legacy servers that ignore Range return a whole file without concatenation", async () => {
  const result = await downloadInChunks(
    { size: CHUNK + 1 },
    {},
    storage(),
    async () => ({ full: true, blob: new Blob(["entire legacy file"]) }),
  );
  assert.equal(await result.text(), "entire legacy file");
});
test("albums group only adjacent media from the same sender and room, preserving item keys", () => {
  const image = { mime_type: "image/png", url: "r2://one" };
  const row = (id, changes = {}) => ({
    id,
    album_id: "album",
    sender_id: "sender",
    room_id: "room",
    attachments: [image],
    ...changes,
  });
  const messages = [
    row("a"),
    row("b"),
    row("c", { sender_id: "other" }),
    row("d", { room_id: "other" }),
    row("e", { is_deleted: true }),
    row("f"),
  ];
  const groups = groupMediaAlbums(messages);
  assert.equal(groups[0].messages.length, 2);
  assert.equal(groups.length, 4);
  assert.equal(groupMediaAlbums([row("a"), row("b")], "b").length, 2);
  assert.equal(viewerItems(messages).length, 5);
  assert.equal(
    viewerItems([row("temporary", { client_id: "same" })])[0].key,
    viewerItems([row("saved", { client_id: "same" })])[0].key,
  );
});
