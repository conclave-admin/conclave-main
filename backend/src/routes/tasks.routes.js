const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const { createTask, listTasks, updateTaskStatus } = require('../controllers/tasks.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);

router.post('/', createTask);
// Cross-room by default: the Tasks page is top-level, so it needs every room the
// caller is in. Mirrors the decisions routes.
router.get('/', listTasks);
// Room-scoped, delegating by rewriting roomId into the query — the same
// approach decisions.routes uses, so one handler serves both routes and the two
// cannot drift apart.
router.get('/room/:roomId', (req, res, next) => {
  req.query.roomId = req.params.roomId;
  return listTasks(req, res, next);
});
router.patch('/:taskId/status', updateTaskStatus);

module.exports = router;