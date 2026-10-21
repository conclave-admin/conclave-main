import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('the ready-page asset handshake claims its document and caches only public assets', async () => {
  const handlers = new Map(); const steps = []; const fetched = []; const pending = [];
  const origin = 'https://conclave.example.test';
  const cache = { match: async () => null, put: async () => { steps.push('cached'); } };
  const source = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    URL,
    self: { location: { origin }, clients: { claim: async () => { steps.push('claimed'); } },
      addEventListener: (name, handler) => handlers.set(name, handler) },
    caches: { open: async () => { steps.push('opened'); return cache; } },
    fetch: async (url) => { fetched.push(url); return { ok: true }; },
  });
  handlers.get('message')({ data: { type: 'CACHE_ASSETS', urls: [
    `${origin}/assets/room.js`, `${origin}/api/messages`, 'https://other.example.test/assets/private.js',
  ] }, waitUntil: (work) => pending.push(work) });
  await Promise.all(pending);
  assert.equal(steps[0], 'claimed');
  assert.deepEqual(fetched, [`${origin}/assets/room.js`]);
  assert.ok(steps.includes('cached'));
});
