"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClientOrigins } = require("../src/config/env");
const { assertTarget } = require("../scripts/provision-moderator");

test("client origin parsing accepts only exact, unique origins", () => {
  assert.deepEqual(
    parseClientOrigins(" https://conclave.com.ng,https://admin.conclave.com.ng,https://conclave.com.ng", ""),
    ["https://conclave.com.ng", "https://admin.conclave.com.ng"],
  );
  assert.throws(() => parseClientOrigins("https://conclave.com.ng/path", ""), /exact HTTP\(S\) origins/);
  assert.throws(() => parseClientOrigins("http://admin.conclave.com.ng", "", true), /exact HTTP\(S\) origins/);
});

test("remote operator provisioning targets cannot be labeled development", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
  };
  try {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgres://operator:secret@db.example.net/conclave";
    assert.throws(
      () => assertTarget({ environment: "development" }, "bootstrap-admin", "operator@example.com"),
      /Remote database targets require/,
    );
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});

test("production provisioning requires exact database target and confirmation", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
  };
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://operator:secret@db.example.net/conclave";
    const options = {
      environment: "production",
      "expected-host": "db.example.net",
      "expected-database": "conclave",
      confirm: "provision:bootstrap-admin:operator@example.com",
    };
    assert.doesNotThrow(() => assertTarget(options, "bootstrap-admin", "operator@example.com"));
    assert.throws(
      () => assertTarget({ ...options, "expected-database": "other" }, "bootstrap-admin", "operator@example.com"),
      /database name/,
    );
    assert.throws(
      () => assertTarget({ ...options, confirm: "wrong" }, "bootstrap-admin", "operator@example.com"),
      /Production confirmation required/,
    );
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});
