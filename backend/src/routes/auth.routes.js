const { Router } = require('express');
const { register, login, refresh, logout } = require('../controllers/auth.controller');
const rateLimit = require('../middlewares/rateLimit.middleware');

const router = Router();

router.post('/register', rateLimit({ windowMs: 60 * 60_000, max: 10 }), register);
router.post('/login', rateLimit({
  windowMs: 15 * 60_000,
  max: 12,
  key: (req) => [req.ip, String(req.body?.email || '').trim().toLowerCase()].filter(Boolean),
}), login);
router.post('/refresh', rateLimit({ windowMs: 15 * 60_000, max: 30 }), refresh);
router.post('/logout', logout);

module.exports = router;
