const ApiError = require("./ApiError");

function validateProjectName(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new ApiError(400, "Project name must be 1–160 characters");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 160)
    throw new ApiError(400, "Project name must be 1–160 characters");
  return normalized;
}

function projectNameConflict(error) {
  if (
    error?.code === "23505" &&
    error.constraint === "projects_team_normalized_name_unique"
  ) {
    return new ApiError(409, "That project name is already used in this team");
  }
  return null;
}

module.exports = { validateProjectName, projectNameConflict };
