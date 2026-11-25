const { query } = require("../config/db");

async function emitToModerators(io, event, payload) {
  if (!io) return;
  const { rows } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.deleted_at IS NULL AND u.suspended_at IS NULL
       AND r.name IN ('moderator','admin')`,
  );
  for (const { id } of rows) io.to(`user:${id}`).emit(event, payload);
}

function emitToModerator(io, userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { emitToModerators, emitToModerator };
