const { Router } = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const validateUuidParams = require('../middlewares/validateParams');
const { getAttachment, getAttachmentUrl, getAttachmentPreviewUrl } = require('../controllers/attachments.controller');

const router = Router();

// Every route here reads or serves room content, so all of it is auth-gated.
router.use(requireAuth);
router.use(validateUuidParams);
// Mounted at /api/attachments, so the full path is /api/attachments/:attachmentId.
// The id is the only parameter and it ends in "Id", so validateUuidParams covers
// it without being declared here.
router.get('/:attachmentId', getAttachment);
router.get('/:attachmentId/url', getAttachmentUrl);
router.get('/:attachmentId/preview-url', getAttachmentPreviewUrl);

module.exports = router;
