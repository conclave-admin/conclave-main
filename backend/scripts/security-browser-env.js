const { randomBytes } = require("node:crypto");

// The disposable browser API must work without a developer .env or CI secrets.
// Never use this configuration for the application server outside this fixture.
function securityBrowserEnv(source, databaseUrl, database) {
  return {
    ...source,
    DATABASE_URL: databaseUrl,
    RATE_LIMIT_KEY_PREFIX: database,
    PORT: "7120",
    CLIENT_ORIGIN: "http://localhost:5188",
    CLIENT_ORIGINS: "http://localhost:5188",
    NODE_ENV: "test",
    JWT_ACCESS_SECRET: randomBytes(32).toString("base64url"),
    JWT_REFRESH_SECRET: randomBytes(32).toString("base64url"),
    JWT_ACCESS_EXPIRES_IN: "15m",
    JWT_REFRESH_EXPIRES_IN: "7d",
    MAIL_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
    BETA_SIGNUPS_ENABLED: "true",
    BETA_MAX_ACTIVE_ACCOUNTS: "250",
    // Fixture-only proxy trust lets signup fixtures represent distinct clients.
    TRUST_PROXY_HOPS: "1",
    SOCKET_REDIS_ADAPTER: "false",
    R2_DIRECT_UPLOADS_ENABLED: "false",
    RESEND_API_KEY: "",
    RESEND_FROM: "",
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
  };
}

module.exports = securityBrowserEnv;
