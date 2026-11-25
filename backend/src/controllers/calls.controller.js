const asyncHandler = require("../utils/asyncHandler");
const { ok } = require("../utils/apiResponse");
const calls = require("../services/call.service");

const listHistory = asyncHandler(async (req, res) =>
  ok(res, { calls: await calls.listHistory(req.user.id) }),
);

const getIceServers = asyncHandler(async (req, res) =>
  ok(res, calls.iceServers(req.user.id)),
);

const listPending = asyncHandler(async (req, res) =>
  ok(res, { calls: await calls.listPending(req.user.id) }),
);

module.exports = { listHistory, getIceServers, listPending };
