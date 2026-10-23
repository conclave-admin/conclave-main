const { Router } = require("express");
const multer = require("multer");
const requireAuth = require("../middlewares/auth.middleware");
const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const env = require("../config/env");
const r2 = require("../config/r2");
const multipart = require("../services/multipartUpload.service");
const rateLimit = require("../middlewares/rateLimit.middleware");
const {
  uploadFile,
  MAX_VIDEO_BYTES,
} = require("../controllers/upload.controller");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 1, fieldSize: 17000 },
});
const router = Router();

router.use(requireAuth);
router.get("/capabilities", (_req, res) =>
  ok(res, {
    multipart: env.r2.directUploads && r2.isConfigured(),
    partSize: multipart.PART_SIZE,
  }),
);
router.post(
  "/sessions",
  rateLimit({ max: 30 }),
  asyncHandler(async (req, res) =>
    ok(res, await multipart.createSession(req.user.id, req.body), 201),
  ),
);
router.get(
  "/sessions/:sessionId",
  asyncHandler(async (req, res) =>
    ok(res, await multipart.getSession(req.user.id, req.params.sessionId)),
  ),
);
router.post(
  "/sessions/:sessionId/parts",
  rateLimit({ max: 120 }),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await multipart.signPart(
        req.user.id,
        req.params.sessionId,
        req.body.partNumber,
      ),
    ),
  ),
);
router.post(
  "/sessions/:sessionId/complete",
  rateLimit({ max: 30 }),
  asyncHandler(async (req, res) =>
    ok(res, await multipart.finalizeSession(req.user.id, req.params.sessionId)),
  ),
);
router.delete(
  "/sessions/:sessionId",
  asyncHandler(async (req, res) =>
    ok(res, await multipart.cancelSession(req.user.id, req.params.sessionId)),
  ),
);
// Permit a full ten-item selection plus retries within one rate-limit window.
router.post("/", rateLimit({ max: 20 }), upload.single("file"), uploadFile);

module.exports = router;
