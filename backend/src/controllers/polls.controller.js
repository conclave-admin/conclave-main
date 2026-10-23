const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const { ok } = require("../utils/apiResponse");
const { createMessage } = require("../services/message.service");
const {
  validatePollInput,
  insertPoll,
  getPoll,
  castVote,
  closePoll,
} = require("../services/poll.service");

// POST /polls  { roomId, question, options: string[], allowMultiple? }
//
// Goes through createMessage, so a poll gets membership checks, the chat-list
// refresh and unread counts like any other message. The poll rows are written
// inside createMessage's own transaction through `inTransaction`.
//
// REST sends are not broadcast by createMessage (only the socket handler
// emits receive-message), so this emits it itself.
const createPoll = asyncHandler(async (req, res) => {
  const { roomId } = req.body;
  if (!roomId) throw new ApiError(400, "roomId is required");

  const draft = validatePollInput(req.body);
  const io = req.app.get("io");

  const message = await createMessage({
    roomId,
    senderId: req.user.id,
    content: draft.question,
    io,
    inTransaction: (client, row) =>
      insertPoll(client, {
        messageId: row.id,
        roomId,
        userId: req.user.id,
        question: draft.question,
        options: draft.options,
        allowMultiple: draft.allowMultiple,
      }),
  });

  if (io) io.to(roomId).emit("receive-message", { message });

  return ok(res, message, 201);
});

// Only the poll is broadcast, never the whole message. A message payload holds
// per-viewer fields (reactions' `reacted`, `pins.mine`), and replacing a
// message wholesale would overwrite those on everyone else's screen.
async function publishPoll(req, { messageId, roomId }) {
  const poll = await getPoll(messageId);
  const io = req.app.get("io");
  if (io) io.to(roomId).emit("poll:updated", { messageId, roomId, poll });
  return poll;
}

// PUT /polls/:pollId/vote  { optionIds: string[] }  (empty array removes the vote)
const voteOnPoll = asyncHandler(async (req, res) => {
  const target = await castVote({
    pollId: req.params.pollId,
    userId: req.user.id,
    optionIds: req.body?.optionIds,
  });
  const poll = await publishPoll(req, target);
  return ok(res, { message_id: target.messageId, poll });
});

// POST /polls/:pollId/close
const closePollHandler = asyncHandler(async (req, res) => {
  const target = await closePoll({
    pollId: req.params.pollId,
    userId: req.user.id,
  });
  const poll = await publishPoll(req, target);
  return ok(res, { message_id: target.messageId, poll });
});

module.exports = { createPoll, voteOnPoll, closePollHandler };
