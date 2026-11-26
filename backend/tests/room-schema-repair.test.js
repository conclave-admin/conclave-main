const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

test("room supersession repair restores missing columns and preserves existing links", async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://app:app@127.0.0.1:5432/postgres",
  });
  const sql = fs.readFileSync(
    path.join(__dirname, "../database/migrations/064_restore_room_supersession.sql"),
    "utf8",
  );
  await db.connect();
  try {
    await db.query("BEGIN");
    // A connection-local table shadows public.rooms; application data is never
    // altered, even when DATABASE_URL points at a populated development DB.
    await db.query("CREATE TEMP TABLE rooms (id UUID PRIMARY KEY) ON COMMIT DROP");
    await db.query(sql);
    const oldRoom = "00000000-0000-4000-8000-000000000001";
    const replacement = "00000000-0000-4000-8000-000000000002";
    await db.query("INSERT INTO rooms(id) VALUES ($1), ($2)", [oldRoom, replacement]);
    await db.query("UPDATE rooms SET superseded_by=$1 WHERE id=$2", [replacement, oldRoom]);
    await db.query(sql);
    assert.equal(
      (await db.query("SELECT superseded_by FROM rooms WHERE id=$1", [oldRoom])).rows[0].superseded_by,
      replacement,
    );
    await db.query("SAVEPOINT invalid_reference");
    await assert.rejects(
      db.query("UPDATE rooms SET superseded_by=$1 WHERE id=$2", ["00000000-0000-4000-8000-000000000003", oldRoom]),
      { code: "23503" },
    );
    await db.query("ROLLBACK TO SAVEPOINT invalid_reference");
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});
