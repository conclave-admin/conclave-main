const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeDisplayName,
  validateDisplayName,
  identityCollisionError,
  validateEmail,
} = require("../src/utils/userIdentity");

test("display-name normalization is deterministic across whitespace and controls", () => {
  assert.equal(normalizeDisplayName("  Ada\t\n  Lovelace  "), "Ada Lovelace");
  assert.equal(normalizeDisplayName("A\u0000B"), "A B");
});

test("email validation normalizes valid input and caps internet-address length", () => {
  assert.equal(validateEmail(" Person@Example.COM "), "person@example.com");
  assert.throws(() => validateEmail(`a@${"x".repeat(249)}.com`), {
    status: 400,
    message: /at most 254/,
  });
  assert.throws(() => validateEmail("not-an-address"), {
    status: 400,
    message: /not a valid address/,
  });
});

test("identity unique constraints map to field-specific conflicts", () => {
  assert.deepEqual(
    {
      status: identityCollisionError({
        code: "23505",
        constraint: "users_email_normalized_unique",
      }).status,
      message: identityCollisionError({
        code: "23505",
        constraint: "users_email_normalized_unique",
      }).message,
    },
    { status: 409, message: "An account with that email already exists" },
  );
  const displayError = identityCollisionError({
    code: "23505",
    constraint: "users_display_name_normalized_unique",
  });
  assert.equal(displayError.status, 409);
  assert.match(displayError.message, /display name/);
  assert.equal(identityCollisionError({ code: "23505", constraint: "other" }), null);
});

test("display-name validation rejects invalid, oversized, and reserved names", () => {
  for (const value of [undefined, null, 42, " \t "]) {
    assert.throws(() => validateDisplayName(value), { status: 400 });
  }
  assert.throws(() => validateDisplayName("x".repeat(101)), {
    message: /at most 100/,
  });
  assert.throws(() => validateDisplayName("Ada\tLovelace"), {
    message: /control characters/,
  });
  assert.throws(() => validateDisplayName("  dElEtEd   UsEr "), {
    message: /reserved/,
  });
});
