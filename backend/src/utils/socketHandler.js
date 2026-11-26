const ApiError = require("./ApiError");

// Socket.IO does not catch rejected promises returned by event listeners.
module.exports = function socketHandler(
  socket,
  handler,
  { payload = true } = {},
) {
  return (...args) => {
    const acknowledge = typeof args[1] === "function" ? args[1] : null;
    return Promise.resolve()
      .then(() => {
        if (
          payload &&
          (!args[0] || typeof args[0] !== "object" || Array.isArray(args[0]))
        ) {
          throw new ApiError(400, "Expected an event payload object");
        }
        return handler(...args);
      })
      .catch((error) => {
        if (!(error instanceof ApiError))
          console.error("Socket event failed", error);
        const message =
          error instanceof ApiError
            ? error.message
            : "Could not complete this action. Please try again.";
        if (acknowledge)
          acknowledge({
            ok: false,
            error: message,
            status: error instanceof ApiError ? error.status : 500,
          });
        if (socket.connected)
          socket.emit("error:message", {
            message,
          });
      })
      .then((value) => {
        if (acknowledge && value !== undefined)
          acknowledge({ ok: true, data: value });
      });
  };
};
