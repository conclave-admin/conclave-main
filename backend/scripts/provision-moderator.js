#!/usr/bin/env node
require("dotenv").config();
const { pool } = require("../src/config/db");

async function main() {
  const [operation, rawEmail] = process.argv.slice(2);
  if (!new Set(["grant", "revoke"]).has(operation) || !rawEmail) {
    throw new Error("Usage: node scripts/provision-moderator.js <grant|revoke> <email>");
  }
  const email = rawEmail.trim().toLowerCase();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const user = (await db.query(
      "SELECT u.id,u.role_id,r.name AS role_name FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE lower(u.email)=$1 AND u.deleted_at IS NULL FOR UPDATE OF u",
      [email])).rows[0];
    if (!user) throw new Error("No active account has that email address");
    const roleName = operation === "grant" ? "moderator" : "user";
    const role = (await db.query("SELECT id,name FROM roles WHERE name=$1", [roleName])).rows[0];
    if (!role) throw new Error(`Expected platform role '${roleName}' is missing from roles`);
    if (user.role_name === "admin") {
      if (operation === "revoke") throw new Error("The script does not change administrator accounts");
      await db.query("COMMIT");
      process.stdout.write(`Account ${email} already has administrator access\n`);
      return;
    }
    if (user.role_name !== roleName) {
      await db.query("UPDATE users SET role_id=$2 WHERE id=$1", [user.id, role.id]);
      await db.query(
        `INSERT INTO moderation_audit(actor_user_id,subject_user_id,action,from_status,to_status,reason,metadata)
         VALUES(NULL,$1,$2,$3,$4,'Operator provisioning script',jsonb_build_object('operator',$5,'source','provision-moderator'))`,
        [user.id, operation === "grant" ? "platform_role_granted" : "platform_role_revoked", user.role_name || "unknown", roleName, process.env.SUDO_USER || process.env.USER || "unknown"]);
    }
    await db.query("COMMIT");
    process.stdout.write(`${operation === "grant" ? "Granted" : "Revoked"} platform moderator access for ${email}\n`);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
