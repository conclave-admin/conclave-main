const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const env = require('../config/env');

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpiresIn,
  });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiresIn,
    // Without a nonce, sessions issued in the same second have identical tokens.
    // A fast rotation could otherwise reissue the token it just revoked.
    jwtid: randomUUID(),
  });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

module.exports = { signAccessToken, signRefreshToken, verifyRefreshToken };
