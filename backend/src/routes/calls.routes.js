const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const validateUuidParams = require("../middlewares/validateParams");
const limit = require("../middlewares/rateLimit.middleware");
const asyncHandler = require("../utils/asyncHandler");
const { listHistory, getIceServers, listPending } = require("../controllers/calls.controller");

router.use(auth);
router.use(validateUuidParams);
router.get("/history", limit({ windowMs: 60_000, max: 60 }), listHistory);
router.get("/ice-servers", limit({ windowMs: 60_000, max: 30 }), getIceServers);
router.get("/pending", limit({ windowMs: 60_000, max: 30 }), listPending);
router.post("/end/:callId", limit({ windowMs: 60_000, max: 20 }), asyncHandler(async (req, res) => {
  const result = await require("../services/call.service").finishCall(
    req.app.get("io"), null, req.user.id, req.params.callId, "end",
  );
  const { ok } = require("../utils/apiResponse");
  return ok(res, result);
}));

module.exports = router;
