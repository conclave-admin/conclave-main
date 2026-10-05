const ApiError = require('./ApiError');

// Socket.IO does not catch rejected promises returned by event listeners.
module.exports = function socketHandler(socket, handler, { payload = true } = {}) {
  return (...args) => Promise.resolve().then(() => {
    if (payload && (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0]))) {
      throw new ApiError(400, 'Expected an event payload object');
    }
    return handler(...args);
  }).catch((error) => {
    if (!(error instanceof ApiError)) console.error('Socket event failed', error);
    if (socket.connected) socket.emit('error:message', {
      message: error instanceof ApiError ? error.message : 'Could not complete this action. Please try again.',
    });
  });
};
