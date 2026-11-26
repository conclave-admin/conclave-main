const { Router } = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const validateUuidParams = require("../middlewares/validateParams");
const {
  getRoomDigest,
  getUserDigest,
  markDigestRead,
} = require("../controllers/digest.controller");

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
// A literal, so it is registered before the room route below. `read` is not a
// path parameter and must never be readable as a roomId.
router.post("/read", markDigestRead); // advance the digest pointer
router.get("/", getUserDigest); // cross-room
router.get("/room/:roomId", getRoomDigest); // per-room

module.exports = router;
