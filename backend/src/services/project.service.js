const ApiError = require("../utils/ApiError");
const {
  validateProjectName,
  projectNameConflict,
} = require("../utils/projectIdentity");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateDescription(value) {
  if (value == null) return "";
  if (typeof value !== "string" || value.trim().length > 2000)
    throw new ApiError(400, "Description must be at most 2000 characters");
  return value.trim();
}

function validateRoomIds(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 20 ||
    new Set(value).size !== value.length ||
    value.some((id) => !UUID.test(id))
  ) {
    throw new ApiError(400, "Choose 1–20 distinct team rooms");
  }
  return value;
}

async function createTeamProject(db, { teamId, userId, name, description, roomIds }) {
  const normalizedName = validateProjectName(name);
  const normalizedDescription = validateDescription(description);
  const selectedRooms = validateRoomIds(roomIds);

  let resolvedTeamId = teamId;
  if (!resolvedTeamId) {
    const teams = await db.query(
      "SELECT DISTINCT team_id FROM rooms WHERE id=ANY($1::uuid[])",
      [selectedRooms],
    );
    if (teams.rowCount !== 1 || !teams.rows[0].team_id)
      throw new ApiError(409, "Project rooms must belong to one team");
    resolvedTeamId = teams.rows[0].team_id;
  }
  if (!UUID.test(resolvedTeamId)) throw new ApiError(400, "Invalid team");

  const team = (
    await db.query(
      `SELECT t.id,t.archived_at,tm.role FROM teams t
       JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=$2
       WHERE t.id=$1 FOR UPDATE OF t,tm`,
      [resolvedTeamId, userId],
    )
  ).rows[0];
  if (!team) throw new ApiError(404, "Team unavailable");
  if (!["owner", "admin"].includes(team.role))
    throw new ApiError(403, "Team owner or administrator required");
  if (team.archived_at) throw new ApiError(409, "Team is archived");

  const rooms = (
    await db.query(
      `SELECT r.id FROM rooms r
       JOIN room_members rm ON rm.room_id=r.id
         AND rm.user_id=$2 AND rm.role='admin'
       WHERE r.id=ANY($1::uuid[]) AND r.team_id=$3 AND r.type<>'dm'
       FOR UPDATE OF r,rm`,
      [selectedRooms, userId, resolvedTeamId],
    )
  ).rows;
  if (rooms.length !== selectedRooms.length)
    throw new ApiError(403, "You must administer every selected team room");

  let project;
  try {
    project = (
      await db.query(
        `INSERT INTO projects(name,description,created_by,team_id)
         VALUES($1,$2,$3,$4) RETURNING *`,
        [normalizedName, normalizedDescription, userId, resolvedTeamId],
      )
    ).rows[0];
  } catch (error) {
    throw projectNameConflict(error) || error;
  }

  for (const roomId of selectedRooms) {
    await db.query(
      "INSERT INTO project_rooms(project_id,room_id) VALUES($1,$2)",
      [project.id, roomId],
    );
    await db.query("UPDATE tasks SET project_id=$1 WHERE room_id=$2", [
      project.id,
      roomId,
    ]);
  }
  return project;
}

module.exports = { createTeamProject };
