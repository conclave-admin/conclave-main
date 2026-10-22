const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const rateLimit = require('../middlewares/rateLimit.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const {
  getMessageReceipts,
  getRoomReceiptSummaries,
  sendMessage,
  listMessages,
  searchMessages,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  pinMessageHandler,
  unpinMessageHandler,
  listPinnedMessages,
  listRoomMedia,
} = require('../controllers/messages.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.post('/', rateLimit({ max: 30 }), sendMessage);
router.get('/room/:roomId', listMessages);
router.get('/room/:roomId/receipts', getRoomReceiptSummaries);
router.get('/room/:roomId/search', searchMessages);
router.get('/room/:roomId/media', listRoomMedia);
// Registered after the two room routes above so `/room/:roomId/pinned` is not
// read as `/room/:roomId` with `pinned` left over. Same two-segment rule that
// governs `/:messageId` below.
router.get('/room/:roomId/pinned', listPinnedMessages);
// Registered after the two room routes so `/room/:roomId` cannot swallow
// `/:messageId`. These are all path-parameter handlers on the message itself.
router.get('/:messageId/receipts', getMessageReceipts);
router.patch('/:messageId', editMessage);
router.delete('/:messageId', deleteMessage);
router.put('/:messageId/reactions', addReaction);
router.delete('/:messageId/reactions/:emoji', removeReaction);
// Pins on the message itself. PUT is idempotent for the caller's own pin, and
// the scope is in the body so a repeat PUT is the same request.
router.put('/:messageId/pin', pinMessageHandler);
router.delete('/:messageId/pin/:scope', unpinMessageHandler);

module.exports = router;
