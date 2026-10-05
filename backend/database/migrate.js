// Minimal, dependency-free migration runner. Applies every .sql file in
// this folder, in filename order, inside a transaction each.
//
// Re-runnable: applied filenames are recorded in schema_migrations and
// skipped on subsequent runs, so pointing this at an existing database no
// longer fails on 001_init.sql (BACKEND_TASKS.md Bug 10).
//
//   node database/migrate.js             apply anything not yet recorded
//   node database/migrate.js --baseline  record existing files WITHOUT
//                                        running them (one-time, for
//                                        databases created before this
//                                        table existed)
//
// Swap for Prisma/Drizzle migrations later if the team picks an ORM
// (see Open Decisions in the PKB) — this just gets day-one dev unblocked.
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/config/db");

const BASELINE = process.argv.includes("--baseline");

async function migrate() {
  const dir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  let locked = false;
  try {
    // Use the same session for the lock and migrations. Rolling deploys may
    // briefly start two runners; only one may inspect/apply the ledger at once.
    await client.query("SET lock_timeout = '60s'");
    await client.query('SELECT pg_advisory_lock(1835102825, 1)');
    locked = true;
    // Bootstrap the tracking table. CREATE TABLE IF NOT EXISTS makes this
    // safe on a database that has never been migrated and on one that has.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // A database that predates this table has no record of what ran, so every
    // file would be replayed. We deliberately do NOT guess: baselining
    // silently could skip a migration that never actually ran, and not
    // baselining makes the operator pass --baseline once, which is visible.
    const { rows } = await client.query(
      "SELECT filename FROM schema_migrations",
    );
    const applied = new Set(rows.map((r) => r.filename));

    if (BASELINE) {
      const missing = files.filter((f) => !applied.has(f));
      if (missing.length === 0) {
        console.log("Nothing to baseline — all files already recorded.");
        return;
      }
      console.log(
        `Baselining ${missing.length} file(s) as already applied: ${missing.join(", ")}`,
      );
      console.log("These were NOT executed. Apply any that are genuinely missing by hand.");
      for (const file of missing) {
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
          [file],
        );
      }
      return;
    }

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log("Nothing to migrate — database is up to date.");
      return;
    }

    // One transaction per file, so a failure rolls back only that file and the
    // error names the file that broke rather than aborting the whole batch.
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      console.log(`Applying ${file}...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`  applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`Migration ${file} failed: ${err.message}`);
        throw err;
      }
    }

    console.log("All migrations complete.");
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(1835102825, 1)');
    } finally {
      client.release();
      await pool.end();
    }
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
