const ApiError = require('./ApiError');
function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new ApiError(416, 'Invalid byte range');
  let start = match[1] ? Number(match[1]) : Math.max(0, size-Number(match[2]));
  let end = match[1] ? match[2] ? Math.min(size-1, Number(match[2])) : size-1 : size-1;
  if (![start,end].every(Number.isSafeInteger) || start < 0 || end < start || start >= size || !size || (!match[1] && Number(match[2]) === 0)) throw new ApiError(416, 'Byte range is outside this file');
  return { start, end, length: end-start+1 };
}
module.exports = { parseByteRange };
