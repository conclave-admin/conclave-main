const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

// TODO: list notifications for req.user.id, newest first, seen/unseen flag
const listNotifications = asyncHandler(async (req, res) => {
  throw new ApiError(501, 'Not implemented');
});

// TODO: mark one or all notifications as seen
const markSeen = asyncHandler(async (req, res) => {
  throw new ApiError(501, 'Not implemented');
});

module.exports = { listNotifications, markSeen };
