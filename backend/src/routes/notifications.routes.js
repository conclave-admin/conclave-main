const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const { listNotifications, markSeen } = require('../controllers/notifications.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.get('/', listNotifications);
router.patch('/seen', markSeen);

module.exports = router;
