const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const {
  sendMessage,
  listMessages,
  searchMessages,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
} = require('../controllers/messages.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.post('/', sendMessage);
router.get('/room/:roomId', listMessages);
router.get('/room/:roomId/search', searchMessages);
// Registered after the two room routes so `/room/:roomId` cannot swallow
// `/:messageId`. These are all path-parameter handlers on the message itself.
router.patch('/:messageId', editMessage);
router.delete('/:messageId', deleteMessage);
router.put('/:messageId/reactions', addReaction);
router.delete('/:messageId/reactions/:emoji', removeReaction);

module.exports = router;
