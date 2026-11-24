const { Router } = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const validateUuidParams = require("../middlewares/validateParams");
const platformModerator = require("../middlewares/platformModerator.middleware");
const moderation = require("../controllers/moderation.controller");

const router = Router();
router.use(requireAuth, platformModerator, validateUuidParams);
router.get("/storage", moderation.getStorageOverview);
router.get("/reports", moderation.listReports);
router.get("/reports/:reportId", moderation.getReport);
router.patch("/reports/:reportId", moderation.transitionReport);
router.post("/users/:userId/suspend", moderation.suspendAccount);
router.post("/users/:userId/restore", moderation.restoreAccount);
module.exports = router;
