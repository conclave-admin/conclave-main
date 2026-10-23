// Disposable PostgreSQL and real Redis/Socket.IO with mocked byte storage.
const { Client } = require("pg");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const env = require("../src/config/env");
const database = `conclave_security_browser_${randomBytes(10).toString("hex")}`;
const url = new URL(env.databaseUrl);
url.pathname = `/${database}`;
const admin = new Client({ connectionString: env.databaseUrl });
let child,
  created = false,
  stopping = false;
async function cleanup(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null) {
    const exited = once(child, "exit").catch(() => {});
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }
  if (created) {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE ${database}`);
  }
  await admin.end().catch(() => {});
  process.exit(code);
}
process.on("SIGTERM", () => cleanup());
process.on("SIGINT", () => cleanup());
(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  const childEnv = {
    ...process.env,
    DATABASE_URL: url.toString(),
    RATE_LIMIT_KEY_PREFIX: database,
    PORT: "7120",
    CLIENT_ORIGIN: "http://localhost:5188",
    NODE_ENV: "test",
    // Fixture-only proxy trust lets signup fixtures represent distinct clients.
    TRUST_PROXY_HOPS: "1",
    R2_DIRECT_UPLOADS_ENABLED: "false",
    RESEND_API_KEY: "",
    RESEND_FROM: "",
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
  };
  const migration = spawn(process.execPath, ["database/migrate.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: childEnv,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const [exit] = await once(migration, "exit");
  if (exit !== 0) throw new Error("Security browser migration failed");
  child = spawn(
    process.execPath,
    [
      "--require",
      path.join(__dirname, "security-test-storage.js"),
      "src/server.js",
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      env: childEnv,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  child.once("exit", (code) => {
    if (!stopping) cleanup(code || 1);
  });
})().catch((error) => {
  console.error("Security browser fixture failed", {
    code: error.code || error.name,
  });
  cleanup(1);
});
