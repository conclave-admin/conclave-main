const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const securityBrowserEnv = require("../scripts/security-browser-env");

test("browser fixture can issue tokens without a developer env or CI secrets", () => {
  const env = securityBrowserEnv({}, "postgres://localhost/disposable", "disposable");
  for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]) {
    assert.equal(Buffer.from(env[key], "base64url").length, 32);
    const token = jwt.sign({ sub: "fixture-user" }, env[key], { expiresIn: "15m" });
    assert.equal(jwt.verify(token, env[key]).sub, "fixture-user");
  }
  assert.notEqual(env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET);
  const next = securityBrowserEnv({}, "postgres://localhost/another", "another");
  assert.notEqual(env.JWT_ACCESS_SECRET, next.JWT_ACCESS_SECRET);
  assert.notEqual(env.JWT_REFRESH_SECRET, next.JWT_REFRESH_SECRET);
});

test("browser fixture overrides conflicting local settings and isolates rate limits", () => {
  const source = {
    JWT_ACCESS_SECRET: "local-access",
    JWT_REFRESH_SECRET: "local-refresh",
    CLIENT_ORIGINS: "https://example.test",
    NODE_ENV: "production",
    RESEND_API_KEY: "local-mail",
    TRUST_PROXY_HOPS: "0",
    BETA_SIGNUPS_ENABLED: "false",
    REDIS_URL: "redis://localhost:6379/15",
  };
  const env = securityBrowserEnv(source, "postgres://localhost/disposable", "disposable");
  assert.equal(env.DATABASE_URL, "postgres://localhost/disposable");
  assert.equal(env.RATE_LIMIT_KEY_PREFIX, "disposable");
  assert.equal(env.REDIS_URL, source.REDIS_URL);
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.CLIENT_ORIGINS, "http://localhost:5188");
  assert.equal(env.TRUST_PROXY_HOPS, "1");
  assert.equal(env.BETA_SIGNUPS_ENABLED, "true");
  assert.equal(env.RESEND_API_KEY, "");
  assert.notEqual(env.JWT_ACCESS_SECRET, source.JWT_ACCESS_SECRET);
  assert.notEqual(env.JWT_REFRESH_SECRET, source.JWT_REFRESH_SECRET);
  assert.equal(source.NODE_ENV, "production");
});
