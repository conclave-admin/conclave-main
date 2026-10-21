const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const {
  createRoom,
  listRooms,
  discoverRooms,
  joinPublicRoom,
  getRoom,
  updateRoom,
  addMember,
  removeMember,
  setMemberRole,
  markRoomSeen,
  updateRoomPreferences,
} = require('../controllers/rooms.controller');

const router = Router();

router.use(requireAuth);
router.use(validateUuidParams);
router.post('/', createRoom);
router.get('/', listRooms);
router.get('/discover', discoverRooms);
router.post('/:roomId/join', joinPublicRoom);
router.get('/:roomId', getRoom);
router.patch('/:roomId', updateRoom);
router.post('/:roomId/members', addMember);
// Multi-segment param routes, registered after the single-segment ones above.
// Express matches whole path segments only, so `/:roomId` cannot read
// `/abc/members/def` as a roomId — `GET /:roomId` is a different method and one
// segment short. Both of these carry two `*Id` params, so validateUuidParams
// checks `roomId` and `userId` without either being declared.
router.delete('/:roomId/members/:userId', removeMember);
router.patch('/:roomId/members/:userId', setMemberRole);
router.post('/:roomId/seen', markRoomSeen);
router.patch('/:roomId/preferences', updateRoomPreferences);

module.exports = router;
