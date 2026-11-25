"use strict";

const { pool } = require("../src/config/db");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argumentsFrom(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--confirm") { values.confirm = true; continue; }
    if (!["--team", "--new-owner", "--operator", "--reason"].includes(key) || !argv[index + 1])
      throw new Error("Usage: npm run team:recover-owner -- --team <uuid> --new-owner <active-admin-user-uuid> --operator <operator> --reason <reason> --confirm");
    values[key.slice(2)] = argv[++index];
  }
  if (!values.confirm || !UUID.test(values.team || "") || !UUID.test(values["new-owner"] || "")
    || !values.operator?.trim() || values.operator.length > 120
    || !values.reason?.trim() || values.reason.trim().length < 10 || values.reason.trim().length > 1000)
    throw new Error("Provide valid team and owner UUIDs, operator, a 10–1,000 character reason, and --confirm.");
  return values;
}

async function main() {
  const args = argumentsFrom(process.argv);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const team = (await client.query(
      "SELECT id,owner_id FROM teams WHERE id=$1 FOR UPDATE", [args.team],
    )).rows[0];
    if (!team) throw new Error("Team not found.");
    if (team.owner_id === args["new-owner"]) throw new Error("The selected account already owns this team.");
    const successor = (await client.query(
      `SELECT tm.role FROM team_members tm JOIN users u ON u.id=tm.user_id
       WHERE tm.team_id=$1 AND tm.user_id=$2 AND tm.role='admin'
         AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
      [team.id, args["new-owner"]],
    )).rows[0];
    if (!successor) throw new Error("The new owner must be an active administrator of this team.");

    await client.query("UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2", [team.id, team.owner_id]);
    await client.query("UPDATE team_members SET role='owner' WHERE team_id=$1 AND user_id=$2", [team.id, args["new-owner"]]);
    await client.query(
      `UPDATE room_members rm SET role=CASE WHEN rm.independent_admin THEN 'admin' ELSE 'member' END,
         team_owner_grant=FALSE
       WHERE rm.user_id=$2 AND rm.team_owner_grant
         AND rm.room_id IN (SELECT id FROM rooms WHERE team_id=$1)`,
      [team.id, team.owner_id],
    );
    await client.query(
      `INSERT INTO room_members(room_id,user_id,role,cleared_sequence,history_start_sequence,team_owner_grant,independent_admin)
       SELECT r.id,$2,'admin',r.message_sequence,r.message_sequence,TRUE,FALSE
       FROM rooms r WHERE r.team_id=$1
       ON CONFLICT(room_id,user_id) DO UPDATE SET role='admin',team_owner_grant=TRUE`,
      [team.id, args["new-owner"]],
    );
    await client.query("UPDATE teams SET owner_id=$2,updated_at=NOW() WHERE id=$1", [team.id, args["new-owner"]]);
    await client.query(
      `INSERT INTO team_audit_events(team_id,actor_label,action,previous_owner_id,new_owner_id,reason)
       VALUES($1,$2,'owner_recovered',$3,$4,$5)`,
      [team.id, args.operator.trim(), team.owner_id, args["new-owner"], args.reason.trim()],
    );
    await client.query("COMMIT");
    process.stdout.write(`Ownership transferred for team ${team.id} to ${args["new-owner"]}.\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Team ownership recovery failed: ${error.message}`);
  process.exitCode = 1;
});
