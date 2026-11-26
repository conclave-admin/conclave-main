const router = require("express").Router();
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const push = require("../services/push.service");
const env = require("../config/env");
const limit = require("../middlewares/rateLimit.middleware");
router.get("/config", (_req, res) =>
  ok(res, {
    configured: push.configured(),
    publicKey: push.configured() ? env.push.publicKey : null,
  }),
);
router.post(
  "/renew",
  limit({ max: 20 }),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await push.renew(
        req.headers.authorization?.replace(/^PushRenew /, ""),
        req.body?.subscription,
      ),
    ),
  ),
);
// Service-worker actions use a short-lived, single-use capability scoped to
// one message and current push subscription. No general API session is stored
// in the worker.
router.post(
  "/actions/mark-read",
  limit({ max: 30, windowMs: 60_000 }),
  asyncHandler(async (req, res) =>
    ok(res, await push.markNotificationReadAction(req.body?.token, req.app.get("io"))),
  ),
);
router.use(require("../middlewares/auth.middleware"));
router.post(
  "/subscriptions",
  limit({ max: 20 }),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await push.register(
        req.user.id,
        req.user.sessionId,
        req.body?.subscription,
      ),
      201,
    ),
  ),
);
router.delete(
  "/subscriptions",
  asyncHandler(async (req, res) => {
    await push.remove(req.user.id, req.body?.endpoint);
    return ok(res, { removed: true });
  }),
);
module.exports = router;
