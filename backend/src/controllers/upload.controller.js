const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

// TODO: accept the multipart/form-data multer already parses in
// upload.routes.js, stream req.file.buffer to
// cloudinary.uploader.upload_stream, then return
// { filename, url, mime_type, size } — the shape createMessage accepts and
// listMessages returns. config/cloudinary.js is already in place for it.
//
// This previously responded 201 with a TODO body, which the client reads as a
// successful upload that simply has no URL. tasks and notifications were changed
// to throw 501 for the same reason (BACKEND_TASKS.md Bug 14); this was missed.
//
// Finishing this is also what closes the client-trusted-URL hole: until an
// upload exists, message.service.js has no record to validate an attachment
// URL against, so it takes whatever the request body contains.
const uploadFile = asyncHandler(async (req, res) => {
  throw new ApiError(501, 'Not implemented');
});

module.exports = { uploadFile };
