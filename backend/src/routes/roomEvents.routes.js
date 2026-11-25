const { Router } = require("express");
const requireAuth = require("../middlewares/auth.middleware");
const validateUuidParams = require("../middlewares/validateParams");
const controller = require("../controllers/roomEvents.controller");

const router = Router({ mergeParams: true });
router.use(requireAuth, validateUuidParams);
router.get("/", controller.listEvents);
router.post("/", controller.createEvent);
router.patch("/:eventId", controller.updateEvent);
router.delete("/:eventId", controller.cancelEvent);
router.put("/:eventId/rsvp", controller.respondToEvent);
module.exports = router;
