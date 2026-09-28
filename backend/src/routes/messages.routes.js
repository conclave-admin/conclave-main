const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const { sendMessage, listMessages, searchMessages } = require('../controllers/messages.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.post('/', sendMessage);
router.get('/room/:roomId', listMessages);
router.get('/room/:roomId/search', searchMessages);

module.exports = router;
