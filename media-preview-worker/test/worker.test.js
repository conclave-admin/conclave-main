import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { createSignature, verifyToken } from '../src/index.js';

const secret = 'a-test-preview-signing-secret-that-is-long-enough';
const key = 'conclave/attachments/123e4567-e89b-12d3-a456-426614174000-chat-photo.png';

test('valid preview signatures are accepted only before expiry', async () => {
  const now = 1_800_000_000;
  const expiresAt = now + 300;
  const signature = await createSignature(key, expiresAt, secret);

  assert.equal(await verifyToken({ key, expiresAt, signature, secret, now }), true);
  assert.equal(await verifyToken({ key, expiresAt, signature, secret, now: expiresAt }), false);
  assert.equal(await verifyToken({ key, expiresAt, signature, secret: `${secret}x`, now }), false);
});

test('preview tokens cannot be used for arbitrary R2 keys or extended beyond their lifetime', async () => {
  const now = 1_800_000_000;
  const expiresAt = now + 301;
  const signature = await createSignature(key, expiresAt, secret);

  assert.equal(await verifyToken({ key: 'private/other-object', expiresAt, signature, secret, now }), false);
  assert.equal(await verifyToken({ key, expiresAt, signature, secret, now }), false);
});

test('the Worker rejects invalid tokens before reading cache or R2', async () => {
  let cacheReads = 0;
  let storageReads = 0;
  globalThis.caches = { default: { match: async () => { cacheReads += 1; } } };
  const request = new Request(`https://preview.example/preview/${key}?exp=1800000300&sig=bad`);
  const result = await worker.fetch(request, {
    PREVIEW_SIGNING_SECRET: secret,
    MEDIA: { get: async () => { storageReads += 1; } },
  }, {});

  assert.equal(result.status, 403);
  assert.equal(result.headers.get('access-control-allow-origin'), '*');
  assert.equal(cacheReads, 0);
  assert.equal(storageReads, 0);
});

test('the Worker transforms private R2 bytes and caches only the fixed preview variant', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 120;
  const signature = await createSignature(key, expiresAt, secret);
  let readKey;
  let cacheKey;
  let transformOptions;
  globalThis.caches = {
    default: {
      match: async () => undefined,
      put: async (request, response) => {
        cacheKey = request.url;
        assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
      },
    },
  };
  const request = new Request(`https://preview.example/preview/${key}?exp=${expiresAt}&sig=${signature}`);
  const result = await worker.fetch(request, {
    PREVIEW_SIGNING_SECRET: secret,
    MEDIA: {
      get: async (requestedKey) => {
        readKey = requestedKey;
        return { body: new Response('original').body, size: 8, httpMetadata: { contentType: 'image/png' } };
      },
    },
    IMAGES: {
      input: (stream) => {
        assert.ok(stream);
        return {
          transform(options) {
            transformOptions = options;
            return this;
          },
          output() { return this; },
          async response({ headers }) { return new Response('preview', { headers }); },
        };
      },
    },
  }, { waitUntil: (promise) => promise });

  assert.equal(result.status, 200);
  assert.equal(result.headers.get('access-control-allow-origin'), '*');
  assert.equal(await result.text(), 'preview');
  assert.equal(result.headers.get('cache-control'), 'private, max-age=30');
  assert.equal(readKey, key);
  assert.deepEqual(transformOptions, { width: 640, height: 480, fit: 'scale-down' });
  assert.equal(cacheKey, `https://preview.example/__cache/chat-preview-v1/${key}`);
});
