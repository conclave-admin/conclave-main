#!/usr/bin/env node
require("dotenv").config();
const { pool } = require("../src/config/db");

function argumentsFrom(argv) {
  const [operation, rawEmail, ...flags] = argv;
  const options = {};
  for (const flag of flags) {
    const match = flag.match(/^--([a-z-]+)=(.*)$/);
    if (!match) throw new Error(`Invalid option: ${flag}`);
    options[match[1]] = match[2];
  }
  if (!new Set(["bootstrap-admin", "grant", "revoke"]).has(operation) || !rawEmail)
    throw new Error("Usage: node scripts/provision-moderator.js <bootstrap-admin|grant|revoke> <email> --operator=<name> [production safeguards]");
  const email = rawEmail.trim().toLowerCase();
  const operator = String(options.operator || "").trim();
  if (!operator || operator.length > 120) throw new Error("--operator=<name> is required (maximum 120 characters)");
  return { operation, email, operator, options };
}

function assertTarget(options, operation, email) {
  const targetEnvironment = options.environment || process.env.NODE_ENV || "development";
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  let target;
  try { target = new URL(process.env.DATABASE_URL); } catch { throw new Error("DATABASE_URL is invalid"); }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const remoteDatabase = !localHosts.has(target.hostname.toLowerCase());
  if (process.env.NODE_ENV === "production" && targetEnvironment !== "production")
    throw new Error("--environment does not match NODE_ENV");
  if (targetEnvironment === "production" && process.env.NODE_ENV !== "production")
    throw new Error("Production provisioning must run with NODE_ENV=production");
  if (remoteDatabase && targetEnvironment !== "production")
    throw new Error("Remote database targets require --environment=production and NODE_ENV=production");
  if (targetEnvironment !== "production") return;

  const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!options["expected-database"] || options["expected-database"] !== database)
    throw new Error("Production requires --expected-database to exactly match the DATABASE_URL database name");
  if (!options["expected-host"] || options["expected-host"].toLowerCase() !== target.host.toLowerCase())
    throw new Error("Production requires --expected-host to exactly match the DATABASE_URL host and port");
  if (options.confirm !== `provision:${operation}:${email}`)
    throw new Error(`Production confirmation required: --confirm=provision:${operation}:${email}`);
}

async function main() {
  const { operation, email, operator, options } = argumentsFrom(process.argv.slice(2));
  assertTarget(options, operation, email);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (operation === "bootstrap-admin") {
      await db.query("SELECT pg_advisory_xact_lock(730041)");
      const existing = await db.query(
        `SELECT 1 FROM users u JOIN roles r ON r.id=u.role_id
         WHERE r.name='admin' AND u.deleted_at IS NULL AND u.suspended_at IS NULL LIMIT 1`,
      );
      if (existing.rowCount) throw new Error("A platform administrator already exists; use the operator console");
    }

    const user = (await db.query(
      `SELECT u.id,u.role_id,u.email_verified_at,u.suspended_at,u.deleted_at,r.name AS role_name
       FROM users u JOIN roles r ON r.id=u.role_id
       WHERE lower(u.email)=$1 FOR UPDATE OF u`,
      [email],
    )).rows[0];
    if (!user || user.deleted_at) throw new Error("No active account has that email address");
    if (!user.email_verified_at) throw new Error("The account email must be verified before granting platform access");
    if (user.suspended_at) throw new Error("Restore the account before changing platform access");

    const nextRole = operation === "bootstrap-admin" ? "admin" : operation === "grant" ? "moderator" : "user";
    if (operation === "bootstrap-admin" && user.role_name === "admin") {
      throw new Error("The selected account is already an administrator; an active administrator exists");
    }
    if (operation === "grant" && user.role_name === "admin")
      throw new Error("Administrator access is managed through the operator console");
    if (operation === "revoke" && user.role_name !== "moderator")
      throw new Error("The selected account is not a platform moderator");
    if (user.role_name !== nextRole) {
      const role = (await db.query("SELECT id FROM roles WHERE name=$1", [nextRole])).rows[0];
      if (!role) throw new Error(`Expected platform role '${nextRole}' is missing from roles`);
      await db.query("UPDATE users SET role_id=$2 WHERE id=$1", [user.id, role.id]);
      await db.query(
        `INSERT INTO moderation_audit(actor_user_id,subject_user_id,action,from_status,to_status,reason,metadata)
         VALUES(NULL,$1,$2,$3,$4,'Operator provisioning script',jsonb_build_object('operator',$5::text,'source','provision-moderator','environment',$6::text))`,
        [
          user.id,
          nextRole === "user" ? "platform_role_revoked" : "platform_role_granted",
          user.role_name,
          nextRole,
          operator,
          options.environment || process.env.NODE_ENV || "development",
        ],
      );
    }
    await db.query("COMMIT");
    process.stdout.write(`${operation === "bootstrap-admin" ? "Bootstrapped platform administrator" : operation === "grant" ? "Granted platform moderator access" : "Revoked platform moderator access"} for ${email}\n`);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { argumentsFrom, assertTarget };
