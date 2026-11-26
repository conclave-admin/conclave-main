const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/db");
const { getProfile } = require("../src/controllers/users.controller");
test("member profile returns only scoped public fields with photo/about privacy", async (t) => {
  t.mock.method(db.pool, "query", async (sql, params) => {
    assert.deepEqual(params, ["target", "viewer"]);
    assert.match(sql, /a.user_id=\$2 AND b.user_id=u.id/);
    assert.match(sql, /privacy_allowed\(u.id,\$2,'photo'\)/);
    assert.match(sql, /privacy_allowed\(u.id,\$2,'about'\)/);
    assert.match(sql, /u.deleted_at IS NULL/);
    assert.doesNotMatch(sql, /email|password/);
    return {
      rows: [
        { id: "target", display_name: "Person", avatar_url: null, bio: null },
      ],
    };
  });
  let body;
  await getProfile(
    { params: { userId: "target" }, user: { id: "viewer" } },
    {
      status() {
        return this;
      },
      json(value) {
        body = value;
      },
    },
    (error) => {
      throw error;
    },
  );
  assert.equal(body.data.id, "target");
  assert.equal(body.data.bio, null);
});
test("unavailable/deleted/nonmember profiles use the same 404 response", async (t) => {
  t.mock.method(db.pool, "query", async () => ({ rows: [] }));
  let error;
  await getProfile(
    { params: { userId: "target" }, user: { id: "viewer" } },
    {},
    (value) => {
      error = value;
    },
  );
  assert.equal(error.status, 404);
  assert.equal(error.message, "Profile not available");
});
