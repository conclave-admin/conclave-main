const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const { getRoomDigest, getUserDigest } = require('../controllers/digest.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.get('/', getUserDigest);                  // cross-room
router.get('/room/:roomId', getRoomDigest);      // per-room

module.exports = router;
