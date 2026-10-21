const KEY_PATTERN = /^conclave\/attachments\/[0-9a-f-]{36}-[\w.-]{1,80}$/i;
const PREVIEW_PREFIX = '/preview/';

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function equalConstantTime(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

export async function createSignature(key, expiresAt, secret) {
  const signingKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    signingKey,
    new TextEncoder().encode(`${key}\n${expiresAt}`),
  );
  return bytesToBase64Url(signature);
}

export async function verifyToken({ key, expiresAt, signature, secret, now = Math.floor(Date.now() / 1000), maxTtl = 300 }) {
  const expiry = Number(expiresAt);
  if (!KEY_PATTERN.test(key) || !Number.isSafeInteger(expiry) || expiry <= now || expiry > now + maxTtl) {
    return false;
  }
  if (typeof secret !== 'string' || secret.length < 32 || typeof signature !== 'string') return false;
  const expected = await createSignature(key, expiry, secret);
  return equalConstantTime(expected, signature);
}

function response(message, status, cacheControl = 'private, no-store') {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': cacheControl,
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function cachedResponse(cached) {
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, max-age=30',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return response('Method not allowed', 405);
    if (!url.pathname.startsWith(PREVIEW_PREFIX)) return response('Not found', 404);

    let key;
    try {
      key = decodeURIComponent(url.pathname.slice(PREVIEW_PREFIX.length));
    } catch {
      return response('Not found', 404);
    }

    const maxTtl = Number(env.MAX_PREVIEW_TOKEN_TTL || 300);
    const expiresAt = url.searchParams.get('exp');
    const signature = url.searchParams.get('sig');
    const valid = await verifyToken({
      key,
      expiresAt,
      signature,
      secret: env.PREVIEW_SIGNING_SECRET,
      maxTtl,
    });
    if (!valid) return response('Preview link expired or invalid', 403);

    // Authorization is checked before cache access. The cache key deliberately
    // omits the short-lived signature so an authorized request can reuse the
    // same immutable transform without making the cached bytes public.
    const cacheUrl = new URL(`/__cache/chat-preview-v1/${key}`, url.origin);
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const cache = caches.default;
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cachedResponse(cached);
    } catch {
      // Cache can be unavailable on local preview hosts; transformation still works.
    }

    let object;
    try {
      object = await env.MEDIA.get(key);
    } catch (err) {
      console.error('R2 preview read failed', { code: err.name });
      return response('Preview is temporarily unavailable', 502);
    }
    if (!object) return response('Preview not found', 404);

    const contentType = object.httpMetadata?.contentType || '';
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
      return response('Unsupported image type', 415);
    }
    if (object.size > 20 * 1024 * 1024) return response('Image is too large to preview', 413);

    try {
      const transformed = await env.IMAGES.input(object.body)
        .transform({ width: 640, height: 480, fit: 'scale-down' })
        .output({ format: 'image/webp', quality: 72, anim: false })
        .response({
          headers: {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=300',
            'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
          },
        });
      if (!transformed.ok) return response('Could not create preview', 502);

      try {
        ctx.waitUntil(cache.put(cacheKey, transformed.clone()));
      } catch {
        // Cache writes are an optimization; return the transformed preview.
      }
      return cachedResponse(transformed);
    } catch (err) {
      console.error('Image preview transform failed', { code: err.name });
      return response('Could not create preview', 502);
    }
  },
};
