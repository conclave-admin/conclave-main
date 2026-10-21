import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, draftMessage } from '../src/lib/outbox.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('Outbox did not reach the expected state');
    await sleep(5);
  }
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function item(id = 'a', extra = {}) {
  return {
    key: `user:room:${id}`, userId: 'user', roomId: 'room', clientId: id,
    tempId: `optimistic-${id}`, createdAt: Date.now(), state: 'queued', sendAttempted: false,
    payload: { roomId: 'room', clientId: id, content: `caption-${id}`,
      replyToId: 'parent', albumId: 'album', mentionedUserIds: ['peer'], attachments: [] },
    media: { blob: new Blob([`file-${id}`], { type: 'image/png' }), filename: `${id}.png` },
    ...extra,
  };
}
function harness(overrides = {}) {
  const rows = new Map();
  const received = [];
  const uploads = [];
  const sent = [];
  let snapshot = [];
  let online = false;
  const store = {
    list: async (userId) => [...rows.values()].filter((row) => row.userId === userId).map((row) => structuredClone(row)),
    add: async (items) => { items.forEach((entry) => rows.set(entry.key, structuredClone(entry))); },
    update: async (entry) => {
      if (!rows.has(entry.key)) return false;
      rows.set(entry.key, structuredClone(entry)); return true;
    },
    cancel: async (key) => {
      if (!rows.has(key) || rows.get(key).sendAttempted) return false;
      return rows.delete(key);
    },
    remove: async (key) => rows.delete(key),
  };
  const options = {
    userId: 'user', store, retryDelay: 5,
    canSend: () => online,
    onChange: (entries) => { snapshot = entries; },
    onSent: (message) => received.push(message),
    onError: (error) => { throw error; },
    prepare: async (blob) => blob,
    remember: async () => {},
    upload: async (blob, { filename, onProgress }) => {
      uploads.push(filename); onProgress(0.5);
      return { url: `r2://bucket/${filename}`, filename, mime_type: blob.type, size: blob.size };
    },
    send: async (payload) => {
      sent.push(payload);
      assert.ok(rows.get(`user:room:${payload.clientId}`).payload.attachments[0].url,
        'the successful upload must be durable before delivery');
      return { id: `saved-${payload.clientId}`, room_id: payload.roomId, client_id: payload.clientId,
        album_id: payload.albumId, attachments: payload.attachments };
    },
    ...overrides,
  };
  const manager = createOutbox(options);
  return { manager, rows, uploads, sent, received, options, store,
    get snapshot() { return snapshot; },
    online(value = true) { online = value; if (value) manager.wake(); else manager.pause(); },
  };
}

test('offline batch preserves file bytes, captions, album, mentions and reply through restore', async (t) => {
  const h = harness(); t.after(() => h.manager.stop());
  await h.manager.start();
  await h.manager.enqueue([item('a'), item('b')]);
  assert.equal(h.uploads.length, 0);
  const restored = await h.store.list('user');
  assert.equal(restored.length, 2);
  assert.equal(await restored[0].media.blob.text(), 'file-a');
  assert.equal(restored[0].payload.replyToId, 'parent');
  assert.deepEqual(restored[0].payload.mentionedUserIds, ['peer']);
  const bubble = draftMessage(restored[0], 'Sender');
  assert.equal(bubble.album_id, 'album');
  assert.equal(await bubble.attachments[0].local_blob.text(), 'file-a');
  assert.equal(bubble.content, 'caption-a');
  h.online();
  await until(() => h.received.length === 2);
  assert.equal(h.rows.size, 0);
  assert.deepEqual(h.uploads, ['a.png', 'b.png']);
  assert.ok(h.sent.every((payload) => payload.albumId === 'album' && payload.attachments.length === 1));
  assert.ok(h.sent.every((payload) => !payload.media && !payload.attachments[0].local_blob));
});

test('a failed durable save starts no upload and publishes no accepted message', async (t) => {
  const h = harness(); t.after(() => h.manager.stop());
  await h.manager.start();
  h.store.add = async () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  h.online();
  await assert.rejects(h.manager.enqueue([item('a'), item('b')]), /Quota exceeded/);
  assert.equal(h.snapshot.length, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.rows.size, 0);
});

test('lost acknowledgement and reload reuse the completed upload and original clientId', async (t) => {
  const h = harness({ retryDelay: 1000, send: async () => { throw new Error('Ack lost'); } });
  t.after(() => h.manager.stop());
  await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => h.snapshot[0]?.attempts === 1);
  h.manager.stop();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.rows.get('user:room:a').payload.attachments[0].url, 'r2://bucket/a.png');
  assert.equal(h.rows.get('user:room:a').sendAttempted, true);
  h.rows.get('user:room:a').retryAt = 0;
  const second = createOutbox({ ...h.options, onSent: (message) => h.received.push(message),
    send: async (payload) => ({ id: 'saved-a', client_id: payload.clientId, album_id: payload.albumId }) });
  t.after(() => second.stop());
  await second.start();
  await until(() => h.received.length === 1);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.received[0].client_id, 'a');
  assert.equal(h.received[0].album_id, 'album');
});

test('cancel aborts an active upload and a late response cannot resurrect or send it', async (t) => {
  const gate = deferred();
  let started = false;
  let signal;
  const h = harness({ upload: async (_, options) => { signal = options.signal; started = true; return gate.promise; } });
  t.after(() => h.manager.stop());
  await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => started);
  await h.manager.cancel('user:room:a');
  assert.ok(signal.aborted);
  gate.resolve({ url: 'r2://late' });
  await sleep(30);
  assert.equal(h.rows.size, 0);
  assert.equal(h.snapshot.length, 0);
  assert.equal(h.sent.length, 0);
});

test('retrying a failed album item keeps its identity and does not resend successful siblings', async (t) => {
  let fail = true;
  const h = harness({ upload: async (blob, options) => {
    if (options.filename === 'b.png' && fail) {
      const error = new Error('File rejected'); error.status = 415; throw error;
    }
    return { url: `r2://bucket/${options.filename}`, mime_type: blob.type };
  } });
  t.after(() => h.manager.stop());
  await h.manager.start(); await h.manager.enqueue([item('a'), item('b')]); h.online();
  await until(() => h.received.length === 1 && h.snapshot[0]?.state === 'failed');
  assert.equal(h.snapshot[0].clientId, 'b');
  fail = false; await h.manager.retry('user:room:b');
  await until(() => h.received.length === 2);
  assert.deepEqual(h.sent.map((payload) => payload.clientId), ['a', 'b']);
  assert.ok(h.sent.every((payload) => payload.albumId === 'album'));
});

test('upload failure explains the reason and waits for manual retry without duplicate work', async (t) => {
  let calls = 0;
  const gate = deferred();
  const h = harness({ upload: async () => {
    calls += 1;
    if (calls === 1) throw new Error('Network unavailable');
    return gate.promise;
  } });
  t.after(() => h.manager.stop());
  await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => h.snapshot[0]?.state === 'failed');
  assert.match(h.snapshot[0].error, /Network unavailable/);
  await h.manager.wake(); await h.manager.wake();
  assert.equal(calls, 1);
  await h.manager.retry('user:room:a');
  await until(() => calls === 2);
  h.manager.wake(); h.manager.wake();
  gate.resolve({ url: 'r2://success' });
  await until(() => h.received.length === 1);
  assert.equal(calls, 2);
  assert.equal(h.sent.length, 1);
});

test('stopping an account during upload prevents late delivery and preserves account isolation', async (t) => {
  const gate = deferred(); let started = false;
  const h = harness({ upload: async () => { started = true; return gate.promise; } });
  t.after(() => h.manager.stop());
  h.rows.set('other', item('other', { key: 'other', userId: 'other-user' }));
  await h.manager.start(); assert.equal(h.snapshot.length, 0);
  await h.manager.enqueue([item()]); h.online(); await until(() => started);
  h.manager.stop(); h.rows.clear();
  gate.resolve({ url: 'r2://late' }); await sleep(30);
  assert.equal(h.rows.size, 0); assert.equal(h.sent.length, 0);
});

test('an attempted send cannot be cancelled while its acknowledgement is unresolved', async (t) => {
  const gate = deferred(); let sending = false;
  const h = harness({ send: async () => { sending = true; return gate.promise; } });
  t.after(() => h.manager.stop());
  await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => sending);
  await assert.rejects(h.manager.cancel('user:room:a'), /Delivery has already started/);
  assert.equal(h.rows.size, 1);
  gate.resolve({ id: 'saved-a' }); await until(() => h.rows.size === 0);
});

test('checkpoint storage failure keeps the successful upload in memory until a safe retry', async (t) => {
  const h = harness(); t.after(() => h.manager.stop());
  const update = h.store.update;
  let storageFull = true;
  h.store.update = async (entry) => {
    if (storageFull && entry.payload.attachments?.length) throw new Error('Quota exceeded');
    return update(entry);
  };
  await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => h.snapshot[0]?.state === 'failed');
  assert.equal(h.snapshot[0].payload.attachments[0].url, 'r2://bucket/a.png');
  await h.manager.refresh(); h.manager.wake(); await sleep(30);
  assert.equal(h.snapshot[0].state, 'failed');
  assert.equal(h.uploads.length, 1);
  storageFull = false;
  await h.manager.retry('user:room:a');
  await until(() => h.received.length === 1);
  assert.equal(h.uploads.length, 1);
});

test('a definitive server rejection allows the unsent draft to be cancelled', async (t) => {
  const h = harness({ send: async () => {
    const error = new Error('Conversation unavailable');
    error.permanent = true; error.definitive = true; error.status = 403; throw error;
  } });
  t.after(() => h.manager.stop());
  await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => h.snapshot[0]?.state === 'failed');
  assert.equal(h.snapshot[0].sendAttempted, false);
  await h.manager.cancel('user:room:a');
  assert.equal(h.rows.size, 0);
});

test('outbox records from the previous version restore as queued without losing their clientId', async (t) => {
  const h = harness(); t.after(() => h.manager.stop());
  const legacy = item(); delete legacy.state; delete legacy.sendAttempted;
  h.rows.set(legacy.key, legacy);
  await h.manager.start();
  assert.equal(h.snapshot[0].state, 'queued');
  assert.equal(h.snapshot[0].clientId, 'a');
  assert.equal(h.snapshot[0].sendAttempted, true);
});

test('manual upload retry respects Retry-After and reuses the draft', async (t) => {
  let clock = 1000; let attempts = 0;
  const h = harness({ now: () => clock, upload: async () => {
    if (++attempts === 1) {
      const error = new Error('Rate limited');
      error.response = { status: 429, headers: { 'retry-after': '2' } };
      throw error;
    }
    return { url: 'r2://after-limit' };
  } });
  t.after(() => h.manager.stop());
  await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => h.snapshot[0]?.state === 'failed');
  assert.match(h.snapshot[0].error, /limit reached/);
  await assert.rejects(h.manager.retry('user:room:a'), /Retry in 2 seconds/);
  await h.manager.wake(); assert.equal(attempts, 1);
  clock = 3000;
  await h.manager.wake(); assert.equal(attempts, 1);
  await h.manager.retry('user:room:a'); await until(() => h.received.length === 1);
  assert.equal(attempts, 2);
  assert.equal(h.sent[0].clientId, 'a');
});


test('generated metadata is durable before upload, restored in bubbles and reused on retry', async (t) => {
  const metadata = { width: 320, height: 240, preview_url: 'data:image/jpeg;base64,thumbnail' };
  let generations = 0; let uploads = 0;
  const h = harness({ prepareMetadata: async () => { generations++; return metadata; }, upload: async (_, options) => {
    uploads++;
    assert.deepEqual(options.metadata, metadata);
    assert.deepEqual(h.rows.get('user:room:a').media.metadata, metadata);
    assert.equal(draftMessage(h.snapshot[0]).attachments[0].width, 320);
    if (uploads === 1) { const error = new Error('Rejected once'); error.status = 415; throw error; }
    return { url: 'r2://metadata', ...metadata };
  } });
  t.after(() => h.manager.stop()); await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => h.snapshot[0]?.state === 'failed'); await h.manager.retry('user:room:a');
  await until(() => h.received.length === 1);
  assert.equal(generations, 1); assert.equal(uploads, 2);
  assert.equal(h.received[0].attachments[0].width, 320);
});

test('an expired unclaimed upload can be uploaded again without changing the message client ID', async (t) => {
  let uploads=0; let sends=0;
  const h = harness({ upload: async () => ({ url:`r2://file-${++uploads}` }),
    send: async (payload) => { if (++sends===1) throw Object.assign(new Error('Attachment is unavailable: it was never uploaded, was uploaded by another user, or is already attached to a message'), { status:400,definitive:true });
      return { id:'saved-a',client_id:payload.clientId,attachments:payload.attachments }; } });
  t.after(() => h.manager.stop()); await h.manager.start(); await h.manager.enqueue([item()]); h.online();
  await until(() => h.snapshot[0]?.state==='failed');
  assert.match(h.snapshot[0].error,/expired/); assert.equal(h.snapshot[0].payload.attachments.length,0);
  await h.manager.retry('user:room:a'); await until(() => h.received.length===1);
  assert.equal(uploads,2); assert.equal(h.received[0].client_id,'a');
});
