const ApiError = require('./ApiError');
const { TextDecoder } = require('util');

async function verifyFileSignature(bytes, declared, streamType) {
  if (declared === 'application/vnd.conclave.encrypted') {
    if (bytes.length < 45 || Buffer.from(bytes.subarray(0,5)).toString() !== 'CCEF1') throw new ApiError(415,'Invalid encrypted file container');
    return;
  }
  if (!bytes.length) throw new ApiError(415, 'Empty files are not supported');
  const { fileTypeFromBuffer } = await import('file-type');
  let detected = streamType;
  try { detected ||= await fileTypeFromBuffer(bytes); } catch { /* Truncated or unknown binary. */ }
  const aliases = { 'audio/x-wav': 'audio/wav', 'application/x-gzip': 'application/gzip',
    'video/m4v': 'video/mp4', 'audio/x-m4a': 'audio/mp4', 'application/x-cfb': 'application/x-cfb' };
  const actual = aliases[detected?.mime] || detected?.mime;
  if (actual === declared) return;
  if (actual === 'application/x-cfb' && ['application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint'].includes(declared)) return;
  // MP4/WebM containers may carry audio only; the container signature is shared.
  if ((actual === 'video/mp4' && declared === 'audio/mp4') || (actual === 'video/webm' && declared === 'audio/webm')
      || (actual === 'application/ogg' && declared === 'audio/ogg')) return;
  if (declared.startsWith('text/') || declared === 'image/svg+xml') {
    if (actual) throw new ApiError(415, 'The file contents do not match its declared type');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); }
    catch { throw new ApiError(415, 'This text file is not valid UTF-8'); }
    if (text.includes('\0')) throw new ApiError(415, 'Binary content cannot be uploaded as text');
    if (declared !== 'image/svg+xml' || /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return;
  }
  throw new ApiError(415, 'The file contents do not match its declared type');
}
module.exports = { verifyFileSignature };
