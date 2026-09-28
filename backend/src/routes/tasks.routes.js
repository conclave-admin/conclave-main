const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const { createTask, listTasks, updateTaskStatus } = require('../controllers/tasks.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.post('/', createTask);
router.get('/room/:roomId', listTasks);
router.patch('/:taskId/status', updateTaskStatus);

module.exports = router;
