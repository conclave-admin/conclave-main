const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const envPath = require.resolve("../src/config/env");

function readTrustProxyHops(nodeEnv, configuredValue = "") {
  const script = `process.stdout.write(String(require(${JSON.stringify(envPath)}).trustProxyHops))`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      TRUST_PROXY_HOPS: configuredValue,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout);
}

test("production defaults to one trusted proxy hop when unset", () => {
  assert.equal(readTrustProxyHops("production"), 1);
});

test("non-production defaults to direct access and explicit values are preserved", () => {
  assert.equal(readTrustProxyHops("development"), 0);
  assert.equal(readTrustProxyHops("production", "0"), 0);
  assert.equal(readTrustProxyHops("production", "2"), 2);
});
