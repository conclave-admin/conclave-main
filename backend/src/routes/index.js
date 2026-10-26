const { Router } = require("express");

const authRoutes = require("./auth.routes");
const usersRoutes = require("./users.routes");
const roomsRoutes = require("./rooms.routes");
const messagesRoutes = require("./messages.routes");
const decisionsRoutes = require("./decisions.routes");
const tasksRoutes = require("./tasks.routes");
const digestRoutes = require("./digest.routes");
const notificationsRoutes = require("./notifications.routes");
const uploadRoutes = require("./upload.routes");
const attachmentsRoutes = require("./attachments.routes");
const pollsRoutes = require("./polls.routes");

const router = Router();
router.use("/experience", require("./experience.routes"));
router.use("/security", require("./security.routes"));
router.use("/encryption", require("./encryption.routes"));

router.use("/push", require("./push.routes"));
router.use("/sync", require("./sync.routes"));
router.use("/auth", authRoutes);
router.use("/users", usersRoutes);
router.use("/rooms", require("./roomLifecycle.routes"));
router.use("/rooms", roomsRoutes);
router.use("/messages", messagesRoutes);
router.use("/links", require("./links.routes"));
router.use("/decisions", decisionsRoutes);
router.use("/tasks", tasksRoutes);
router.use("/digest", digestRoutes);
router.use("/notifications", notificationsRoutes);
router.use("/upload", uploadRoutes);
router.use("/attachments", attachmentsRoutes);
router.use("/polls", pollsRoutes);

module.exports = router;
