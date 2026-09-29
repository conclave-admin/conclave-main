const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const { getMe, updateProfile, listUsers, deleteMe } = require('../controllers/users.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.get('/me', getMe);
router.patch('/me', updateProfile);
router.delete('/me', deleteMe);
router.get('/', listUsers);

module.exports = router;
