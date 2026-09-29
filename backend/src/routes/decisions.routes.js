const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const {
  promoteToDecision,
  listDecisions,
  searchDecisions,
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

module.exports = router;
