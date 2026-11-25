const { Router } = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const validateUuidParams = require("../middlewares/validateParams");
const platformModerator = require("../middlewares/platformModerator.middleware");
const platformAdmin = require("../middlewares/platformAdmin.middleware");
const moderation = require("../controllers/moderation.controller");
const appeals = require("../controllers/appeals.controller");
const rateLimit = require("../middlewares/rateLimit.middleware");

const router = Router();
const appealLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  key: (req) => [req.ip, String(req.body?.email || "").trim().toLowerCase()],
});
// Public so a suspended account can request and check an appeal without a
// session. Credentials are verified and the response does not reveal whether
// an account or eligible case exists.
router.post("/appeals/request", appealLimit, appeals.submitAppeal);
router.post("/appeals/status", appealLimit, appeals.appealStatus);
router.use(requireAuth);
router.get("/access", moderation.getAccess);
router.use(platformModerator, validateUuidParams);
router.get("/operators", platformAdmin, moderation.listOperators);
router.patch("/operators/:userId/role", platformAdmin, moderation.changeOperatorRole);
router.get("/storage", moderation.getStorageOverview);
router.get("/moderators", appeals.listModerators);
router.get("/reports", moderation.listReports);
router.get("/reports/:reportId", moderation.getReport);
router.patch("/reports/:reportId", moderation.transitionReport);
router.patch("/reports/:reportId/assignment", moderation.assignReport);
router.post("/users/:userId/suspend", moderation.suspendAccount);
router.post("/users/:userId/restore", moderation.restoreAccount);
router.get("/appeals", appeals.listAppeals);
router.get("/appeals/:appealId", appeals.getAppeal);
router.patch("/appeals/:appealId/assignment", appeals.assignAppeal);
router.patch("/appeals/:appealId", appeals.transitionAppeal);
module.exports = router;
