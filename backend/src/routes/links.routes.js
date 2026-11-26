const { Router } = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const rateLimit = require("../middlewares/rateLimit.middleware");
const { ok } = require("../utils/apiResponse");
const { linkPreview } = require("../services/linkPreview.service");

const router = Router();
router.use(requireAuth);
router.get("/preview", rateLimit({ max: 60 }), async (req, res, next) => {
  try {
    const preview = await linkPreview(req.query.url);
    return ok(res, preview);
  } catch {
    // Some sites block automated requests. The client still displays the link.
    return ok(res, null);
  }
});
module.exports = router;
