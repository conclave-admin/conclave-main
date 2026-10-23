const { Router } = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const validateUuidParams = require("../middlewares/validateParams");
const rateLimit = require("../middlewares/rateLimit.middleware");
const {
  getMe,
  updateProfile,
  listUsers,
  searchUsers,
  listSharedRooms,
  getAvatarUrl,
  getBlockStatus,
  blockUser,
  unblockUser,
  reportUser,
  deleteMe,
} = require("../controllers/users.controller");
const {
  getPreferences,
  updatePreferences,
} = require("../controllers/preferences.controller");

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
// `/search` is a literal and is registered before the collection route, so it
// can never be read as something else. Today `router.get('/')` is exact-matched
// and would not swallow it either, but the ordering that makes that true is not
// obvious from the route list alone — and the day a `/:userId` route lands here
// it will be.
router.get("/search", searchUsers);
router.get("/avatar-url", rateLimit({ max: 120 }), getAvatarUrl);
router.get("/me", getMe);
router.patch("/me", updateProfile);
router.delete("/me", deleteMe);
router.get("/:userId/shared-rooms", listSharedRooms);
router.get("/:userId/block", getBlockStatus);
router.post("/:userId/block", blockUser);
router.delete("/:userId/block", unblockUser);
router.post(
  "/:userId/report",
  rateLimit({ max: 5, windowMs: 60 * 60 * 1000 }),
  reportUser,
);
// Preferences hang off the caller, so they sit beside /me rather than under a
// collection. A row is created on first write, never on read: GET answers from
// defaults for an account that has never opened Settings.
router.get("/me/preferences", getPreferences);
router.patch("/me/preferences", updatePreferences);
router.get("/", listUsers);

module.exports = router;
