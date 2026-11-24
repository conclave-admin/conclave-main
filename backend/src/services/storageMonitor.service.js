const env = require("../config/env");
const { query } = require("../config/db");

async function getStorageOverview(db = { query }) {
  const [usage, cleanup, teams, accounts] = await Promise.all([
    db.query(`SELECT count(*) FILTER (WHERE retired_at IS NULL)::int AS objects,
       COALESCE(sum(size_bytes) FILTER (WHERE retired_at IS NULL),0)::text AS total_bytes,
       COALESCE(sum(size_bytes) FILTER (WHERE retired_at IS NULL AND resource_type='r2'),0)::text AS r2_bytes,
       COALESCE(sum(size_bytes) FILTER (WHERE retired_at IS NULL AND resource_type IS DISTINCT FROM 'r2'),0)::text AS legacy_bytes,
       count(*) FILTER (WHERE attached_message_id IS NULL AND retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_url=file_uploads.file_url AND u.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.avatar_url=file_uploads.file_url))::int AS unclaimed_objects,
       COALESCE(sum(size_bytes) FILTER (WHERE attached_message_id IS NULL AND retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_url=file_uploads.file_url AND u.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.avatar_url=file_uploads.file_url)),0)::text AS unclaimed_bytes,
       count(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired_objects
       FROM file_uploads`),
    db.query(`SELECT count(*)::int AS queued,
       count(*) FILTER (WHERE attempts>=3)::int AS repeated_failures,
       min(created_at) AS oldest_created_at
       FROM storage_deletion_jobs`),
    db.query(`SELECT r.team_id,t.name AS team_name,count(DISTINCT a.id)::int AS objects,
       COALESCE(sum(a.size_bytes),0)::text AS bytes
       FROM attachments a JOIN messages m ON m.id=a.message_id
       JOIN rooms r ON r.id=m.room_id JOIN teams t ON t.id=r.team_id
       WHERE m.deleted_at IS NULL GROUP BY r.team_id,t.name
       ORDER BY sum(a.size_bytes) DESC LIMIT 20`),
    db.query(`SELECT u.id,u.display_name,count(f.id)::int AS objects,
       COALESCE(sum(f.size_bytes),0)::text AS bytes
       FROM file_uploads f JOIN users u ON u.id=f.uploader_id
       WHERE f.retired_at IS NULL GROUP BY u.id,u.display_name
       ORDER BY sum(f.size_bytes) DESC LIMIT 20`),
  ]);
  const totalBytes = Number(usage.rows[0].total_bytes);
  const gb = 1024 ** 3;
  const estimate = env.beta.storageUsdPerGbMonth > 0
    ? totalBytes / gb * env.beta.storageUsdPerGbMonth
    : null;
  return {
    generatedAt: new Date().toISOString(),
    usage: { ...usage.rows[0], total_gb: totalBytes / gb },
    cleanup: cleanup.rows[0],
    topTeams: teams.rows,
    topAccounts: accounts.rows,
    limits: {
      maxActiveAccounts: env.beta.maxActiveAccounts,
      storageAlertGb: env.beta.storageAlertGb,
      storageUsdPerGbMonth: env.beta.storageUsdPerGbMonth || null,
      storageMonthlyBudgetUsd: env.beta.storageMonthlyBudgetUsd || null,
    },
    estimatedStorageOnlyMonthlyUsd: estimate,
    alerts: {
      storageThresholdExceeded: env.beta.storageAlertGb > 0 && totalBytes / gb >= env.beta.storageAlertGb,
      storageBudgetExceeded: estimate != null && env.beta.storageMonthlyBudgetUsd > 0 && estimate >= env.beta.storageMonthlyBudgetUsd,
      deletionFailures: Number(cleanup.rows[0].repeated_failures) > 0,
      costRateUnconfigured: env.beta.storageUsdPerGbMonth <= 0,
    },
  };
}

module.exports = { getStorageOverview };
