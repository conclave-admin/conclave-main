const { Router } = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const validateUuidParams = require("../middlewares/validateParams");
const {
  createPoll,
  voteOnPoll,
  closePollHandler,
} = require("../controllers/polls.controller");

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);

router.post("/", createPoll);
router.put("/:pollId/vote", voteOnPoll);
router.post("/:pollId/close", closePollHandler);

module.exports = router;
