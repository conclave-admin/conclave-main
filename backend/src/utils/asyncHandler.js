// Wraps an async route/controller so thrown errors reach Express's error
// middleware instead of crashing the process.
const asyncHandler = (fn) => (req, res, next) => {
  return Promise.resolve().then(() => fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
