const { Router } = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const validateUuidParams = require("../middlewares/validateParams");
const rateLimit = require("../middlewares/rateLimit.middleware");
const {
  getAttachment,
  getAttachmentUrl,
  getAttachmentPreviewUrl,
} = require("../controllers/attachments.controller");

const router = Router();

// Every route here reads or serves room content, so all of it is auth-gated.
router.use(requireAuth);
router.use(validateUuidParams);

// The byte-serving route only. Seeking inside a video issues one Range request
// per scrub and a resumed download issues one per chunk, so the budget is far
// higher than a normal endpoint's 30/min — this exists to bound how much
// storage egress one account can pull from one asset in a minute, not to catch
// bots. The limiter's scope is the route path, so the key is the account:
// reach for a different file and you get that file's own budget back.
const SERVE_BUDGET = { max: 240 };

// Mounted at /api/attachments, so the full path is /api/attachments/:attachmentId.
// The id is the only parameter and it ends in "Id", so validateUuidParams covers
// it without being declared here.
router.get(
  "/:attachmentId",
  rateLimit(SERVE_BUDGET),
  getAttachment,
);
router.get("/:attachmentId/url", getAttachmentUrl);
router.get("/:attachmentId/preview-url", getAttachmentPreviewUrl);

module.exports = router;
