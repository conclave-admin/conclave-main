const { query } = require("../config/db");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

module.exports = asyncHandler(async (req, _res, next) => {
  const result = await query(
    `SELECT r.name FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.id=$1 AND u.deleted_at IS NULL AND u.suspended_at IS NULL`,
    [req.user.id],
  );
  if (result.rows[0]?.name !== "admin")
    throw new ApiError(403, "Platform administrator access required");
  return next();
});
