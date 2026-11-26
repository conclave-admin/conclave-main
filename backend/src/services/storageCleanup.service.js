const { pool } = require("../config/db");
const r2 = require("../config/r2");
const cloudinary = require("../config/cloudinary");
const env = require("../config/env");
let timer;
let running;

async function queueRetired(client) {
  // Row locks serialize retirement with attachment claims and avatar updates.
  await client.query(
    `UPDATE media_upload_sessions SET status = 'expired' WHERE status = 'uploading' AND expires_at < NOW()`,
  );
  await client.query(`WITH terminal AS (
    UPDATE media_upload_sessions SET cleanup_queued_at = NOW() WHERE status IN ('expired','cancelled','rejected') AND cleanup_queued_at IS NULL
    RETURNING object_key, upload_id
  ) INSERT INTO storage_deletion_jobs(provider, object_key, upload_id)
    SELECT 'r2', object_key, CASE WHEN kind = 1 THEN upload_id ELSE '' END FROM terminal CROSS JOIN generate_series(1,2) kind ON CONFLICT DO NOTHING`);
  await client.query(`WITH candidates AS (
    SELECT f.id FROM file_uploads f WHERE attached_message_id IS NULL AND retired_at IS NULL
      AND created_at < NOW() - INTERVAL '1 day' AND public_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_url = f.file_url AND u.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.avatar_url = f.file_url)
      AND NOT EXISTS (SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.file_url = f.file_url AND m.deleted_at IS NULL)
    ORDER BY f.created_at LIMIT 100 FOR UPDATE OF f SKIP LOCKED
  ), retired AS (
    UPDATE file_uploads SET retired_at = NOW() WHERE id IN (SELECT id FROM candidates) RETURNING public_id, resource_type
  ) INSERT INTO storage_deletion_jobs(provider, object_key, resource_type)
    SELECT CASE WHEN resource_type = 'r2' THEN 'r2' ELSE 'cloudinary' END, public_id, COALESCE(resource_type,'image') FROM retired ON CONFLICT DO NOTHING`);
}
async function processJob(client, job) {
  const used = await client.query(
    `SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE a.public_id = $1 AND m.deleted_at IS NULL AND (CASE WHEN $2 = 'r2' THEN a.resource_type = 'r2' ELSE COALESCE(a.resource_type,'image') <> 'r2' END)
    UNION ALL
    SELECT 1 FROM file_uploads f WHERE f.public_id = $1 AND (
      EXISTS (SELECT 1 FROM users u WHERE u.avatar_url = f.file_url AND u.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM rooms r WHERE r.avatar_url = f.file_url)
    ) LIMIT 1`,
    [job.object_key, job.provider],
  );
  if (used.rowCount) {
    await client.query(
      "UPDATE storage_deletion_jobs SET next_attempt_at = NOW() + INTERVAL '1 day', last_error = 'ActiveReference' WHERE id = $1",
      [job.id],
    );
    return;
  }
  {
    if (job.provider === "r2") {
      if (!r2.isConfigured()) throw new Error("R2 is not configured");
      if (job.upload_id) {
        try {
          await r2.abortMultipart(job.object_key, job.upload_id);
        } catch (error) {
          if (error.name !== "NoSuchUpload") throw error;
        }
      } else await r2.deleteObject(job.object_key);
    } else {
      if (!cloudinary.isConfigured())
        throw new Error("Legacy storage is not configured");
      await cloudinary.uploader.destroy(job.object_key, {
        resource_type: job.resource_type || "image",
        invalidate: true,
      });
    }
  }
  await client.query("DELETE FROM storage_deletion_jobs WHERE id = $1", [
    job.id,
  ]);
}
async function runStorageCleanup({ limit = 50 } = {}) {
  const client = await pool.connect();
  let completed = 0;
  let failed = 0;
  try {
    await client.query("BEGIN");
    await queueRetired(client);
    await client.query("COMMIT");
    for (let index = 0; index < limit; index++) {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT * FROM storage_deletion_jobs WHERE next_attempt_at <= NOW() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!rows.length) {
        await client.query("COMMIT");
        break;
      }
      const job = rows[0];
      await client.query("SAVEPOINT storage_job");
      try {
        await processJob(client, job);
        completed++;
      } catch (error) {
        failed++;
        await client.query("ROLLBACK TO SAVEPOINT storage_job");
        await client.query(
          `UPDATE storage_deletion_jobs SET attempts = attempts + 1,
          next_attempt_at = NOW() + make_interval(secs => LEAST(86400, 30 * power(2, LEAST(attempts, 11)))::double precision), last_error = $2 WHERE id = $1`,
          [job.id, String(error.name || "StorageError").slice(0, 100)],
        );
      }
      await client.query("COMMIT");
    }
    return { completed, failed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
function startStorageCleanup() {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = runStorageCleanup()
      .catch((error) =>
        console.error("Media cleanup failed", {
          code: error.code || error.name,
        }),
      )
      .finally(() => {
        running = null;
      });
  }, env.r2.cleanupIntervalMs);
  timer.unref?.();
}
async function stopStorageCleanup() {
  clearInterval(timer);
  timer = null;
  await running;
}
module.exports = {
  runStorageCleanup,
  startStorageCleanup,
  stopStorageCleanup,
  queueRetired,
};
