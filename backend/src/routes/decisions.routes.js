const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const {
  promoteToDecision,
  listDecisions,
  searchDecisions,
  getDecision,
  pinDecision,
  unpinDecision,
} = require('../controllers/decisions.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.post('/', promoteToDecision);
router.get('/', listDecisions);                           // cross-room (optional ?roomId=, ?before=)
router.get('/search', searchDecisions);                  // cross-room search
router.get('/room/:roomId', (req, res, next) => {         // backward-compatible room-scoped
  req.query.roomId = req.params.roomId;
  return listDecisions(req, res, next);
});
router.get('/room/:roomId/search', searchDecisions);
// Registered after every literal and two-segment GET above, so `/search` and
// `/room/:roomId` cannot be captured by it. It is the only GET that reads a
// decision id, and it sits before the pin routes because those are the actions
// on the decision this returns.
router.get('/:decisionId', getDecision);
// Both are path-parameter handlers on the decision itself.
router.put('/:decisionId/pin', pinDecision);             // { scope: 'user' | 'room' }
router.delete('/:decisionId/pin/:scope', unpinDecision);

module.exports = router;
