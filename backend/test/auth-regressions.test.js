const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
const db = require('../src/config/db');
const { signRefreshToken, verifyRefreshToken } = require('../src/services/token.service');
const { login } = require('../src/controllers/auth.controller');

test('refresh tokens remain unique even within a single second', () => {
  const tokens = Array.from({ length: 20 }, () => signRefreshToken({ id: 'user-id' }));
  assert.equal(new Set(tokens).size, 20);
  for (const token of tokens) {
    const claims = verifyRefreshToken(token);
    assert.equal(claims.sub, 'user-id');
    assert.ok(claims.jti);
  }
});

test('login never returns the stored password hash', async (t) => {
  const password_hash = await bcrypt.hash('correct-password', 4);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM users')) return { rows: [{ id: 'user-id', email: 'victor@example.com', display_name: 'Victor', password_hash }] };
    return { rows: [] };
  });
  let body;
  const response = { status() { return this; }, json(value) { body = value; } };
  await login({ body: { email: 'victor@example.com', password: 'correct-password' } }, response, (error) => { throw error; });
  assert.equal(body.success, true);
  assert.equal(body.data.user.display_name, 'Victor');
  assert.equal(Object.hasOwn(body.data.user, 'password_hash'), false);
  assert.equal(JSON.stringify(body).includes(password_hash), false);
  assert.ok(body.data.accessToken);
  assert.ok(body.data.refreshToken);
});
