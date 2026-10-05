import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
  removeItem: (key) => stored.delete(key),
};
globalThis.window = new EventTarget();
let respond;
axios.defaults.adapter = (config) => respond(config);
const { api, refreshAccessToken } = await import('../src/lib/api.js');
const { saveSession } = await import('../src/lib/session.js');

function reject(config, status) {
  return Promise.reject(new axios.AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { status, config }));
}
function success(config, data) {
  return Promise.resolve({ status: 200, data, config, headers: {} });
}
test.beforeEach(() => {
  stored.clear();
  saveSession({ accessToken: 'old-access', refreshToken: 'old-refresh' });
});

test('concurrent 401 responses share a refresh and persist both rotated tokens', async () => {
  let refreshes = 0;
  respond = async (config) => {
    if (config.url === '/auth/refresh') {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return success(config, { data: { accessToken: 'new-access', refreshToken: 'new-refresh' } });
    }
    if (config.headers.Authorization === 'Bearer old-access') return reject(config, 401);
    return success(config, { ok: true });
  };
  const responses = await Promise.all([api.get('/rooms'), api.get('/users/me')]);
  assert.equal(refreshes, 1);
  assert.ok(responses.every(({ data }) => data.ok));
  assert.equal(stored.get('accessToken'), 'new-access');
  assert.equal(stored.get('refreshToken'), 'new-refresh');
});

test('a request retries at most once', async () => {
  let attempts = 0;
  respond = (config) => {
    if (config.url === '/auth/refresh') return success(config, { data: { accessToken: 'new-access', refreshToken: 'new-refresh' } });
    attempts++;
    return reject(config, 401);
  };
  await assert.rejects(api.get('/rooms'));
  assert.equal(attempts, 2);
});

test('invalid refresh ends the session and notifies React', async () => {
  let ended = false;
  window.addEventListener('conclave:session-ended', () => { ended = true; }, { once: true });
  respond = (config) => reject(config, 401);
  await assert.rejects(api.get('/rooms'));
  assert.equal(stored.size, 0);
  assert.equal(ended, true);
});

test('a temporary refresh outage preserves the session for a retry', async () => {
  respond = (config) => reject(config, 503);
  await assert.rejects(refreshAccessToken());
  assert.equal(stored.get('refreshToken'), 'old-refresh');
});

test('login errors do not trigger refresh', async () => {
  const calls = [];
  respond = (config) => { calls.push(config.url); return reject(config, 401); };
  await assert.rejects(api.post('/auth/login', {}));
  assert.deepEqual(calls, ['/auth/login']);
});

test('a refresh in flight cannot overwrite a new session', async () => {
  let finish;
  respond = (config) => new Promise((resolve) => { finish = () => resolve(success(config, { data: { accessToken: 'stale', refreshToken: 'stale' } })); });
  const pending = refreshAccessToken();
  saveSession({ accessToken: 'new-login', refreshToken: 'new-login-refresh' });
  finish();
  await assert.rejects(pending, /Session changed/);
  assert.equal(stored.get('accessToken'), 'new-login');
});
