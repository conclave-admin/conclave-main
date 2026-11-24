const ApiError = require("./ApiError");

const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_DISPLAY_NAMES = new Set(["deleted user"]);

function normalizeDisplayName(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateEmail(value) {
  const normalized = normalizeEmail(value);
  if (!normalized) throw new ApiError(400, "email is required");
  if (normalized.length > MAX_EMAIL_LENGTH) {
    throw new ApiError(400, `email must be at most ${MAX_EMAIL_LENGTH} characters`);
  }
  if (!EMAIL_RE.test(normalized)) {
    throw new ApiError(400, "email is not a valid address");
  }
  return normalized;
}

function validateDisplayName(value, fieldName = "displayName") {
  if (typeof value !== "string") {
    throw new ApiError(400, `${fieldName} is required`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ApiError(400, `${fieldName} cannot contain control characters`);
  }
  const normalized = normalizeDisplayName(value);
  if (!normalized) throw new ApiError(400, `${fieldName} is required`);
  if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ApiError(
      400,
      `${fieldName} must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  if (RESERVED_DISPLAY_NAMES.has(normalized.toLocaleLowerCase("en-US"))) {
    throw new ApiError(400, `${fieldName} is reserved`);
  }
  return normalized;
}

function identityCollisionError(error) {
  if (error?.code !== "23505") return null;
  if (
    error.constraint === "users_email_normalized_unique" ||
    error.constraint === "users_email_key"
  ) {
    return new ApiError(409, "An account with that email already exists");
  }
  if (error.constraint === "users_display_name_normalized_unique") {
    return new ApiError(409, "That display name is already taken");
  }
  return null;
}

module.exports = {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  normalizeDisplayName,
  normalizeEmail,
  validateEmail,
  validateDisplayName,
  identityCollisionError,
};
