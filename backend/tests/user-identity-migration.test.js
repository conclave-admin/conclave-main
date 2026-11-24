const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const migrationSql = fs.readFileSync(
  path.join(__dirname, "../database/migrations/065_unique_user_identity.sql"),
  "utf8",
);

async function withTemporaryUsers(run) {
  const db = new Client({
    connectionString:
      process.env.DATABASE_URL || "postgres://app:app@127.0.0.1:5432/postgres",
  });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query(`
      CREATE TEMP TABLE users (
        id UUID PRIMARY KEY,
        email TEXT,
        display_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ
      ) ON COMMIT DROP
    `);
    await run(db);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
}

test("migration 065 normalizes identity and resolves display-name collisions deterministically", async () => {
  await withTemporaryUsers(async (db) => {
    await db.query(`
      INSERT INTO users(id, email, display_name, created_at, deleted_at) VALUES
        ('00000000-0000-4000-8000-000000000001', ' Alice@Example.COM ', '  Alice   Smith  ', '2025-01-01', NULL),
        ('00000000-0000-4000-8000-000000000002', 'bob@example.com', E'Alice\tSmith', '2025-01-02', NULL),
        ('00000000-0000-4000-8000-000000000003', 'carol@example.com', 'Deleted user', '2025-01-03', NULL),
        ('00000000-0000-4000-8000-000000000004', NULL, 'Deleted user', '2025-01-04', '2025-02-01')
    `);

    await db.query(migrationSql);
    await db.query(migrationSql);

    const { rows } = await db.query(
      "SELECT email, display_name, deleted_at FROM users ORDER BY created_at",
    );
    assert.deepEqual(rows, [
      { email: "alice@example.com", display_name: "Alice Smith", deleted_at: null },
      { email: "bob@example.com", display_name: "Alice Smith #2", deleted_at: null },
      { email: "carol@example.com", display_name: "User", deleted_at: null },
      {
        email: null,
        display_name: "Deleted user",
        deleted_at: new Date("2025-02-01T00:00:00.000Z"),
      },
    ]);
    const audit = await db.query(
      "SELECT previous_display_name, normalized_display_name, reason FROM identity_migration_065_changes ORDER BY normalized_display_name",
    );
    assert.deepEqual(audit.rows, [
      {
        previous_display_name: "  Alice   Smith  ",
        normalized_display_name: "Alice Smith",
        reason: "normalized",
      },
      {
        previous_display_name: "Alice\tSmith",
        normalized_display_name: "Alice Smith #2",
        reason: "collision",
      },
      {
        previous_display_name: "Deleted user",
        normalized_display_name: "User",
        reason: "reserved",
      },
    ]);

    await db.query("SAVEPOINT duplicate_display_name");
    await assert.rejects(
      db.query(`
        INSERT INTO users(id, email, display_name, created_at)
        VALUES ('00000000-0000-4000-8000-000000000005', 'new@example.com', 'alice smith', NOW())
      `),
      { code: "23505" },
    );
    await db.query("ROLLBACK TO SAVEPOINT duplicate_display_name");
    await db.query("SAVEPOINT non_normalized_email");
    await assert.rejects(
      db.query(`
        INSERT INTO users(id, email, display_name, created_at)
        VALUES ('00000000-0000-4000-8000-000000000006', 'Mixed@Example.com', 'Unique person', NOW())
      `),
      { code: "23514" },
    );
    await db.query("ROLLBACK TO SAVEPOINT non_normalized_email");
  });
});

test("migration 065 refuses ambiguous case-insensitive email accounts", async () => {
  await withTemporaryUsers(async (db) => {
    await db.query(`
      INSERT INTO users(id, email, display_name, created_at) VALUES
        ('00000000-0000-4000-8000-000000000001', 'person@example.com', 'Person One', '2025-01-01'),
        ('00000000-0000-4000-8000-000000000002', ' PERSON@example.com ', 'Person Two', '2025-01-02')
    `);
    await assert.rejects(db.query(migrationSql), {
      code: "23505",
      message: /differ only by case or surrounding whitespace/,
    });
  });
});
