const ApiError = require('./ApiError');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseMediaPage(query, roomId) {
  const kind = query.kind ?? 'media';
  if (!['media', 'documents', 'audio'].includes(kind)) throw new ApiError(400, 'Invalid shared-file section');
  const limit = query.limit === undefined ? 24 : Number(query.limit);
  if ((query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit))) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'limit must be between 1 and 100');
  let after = null;
  if (query.after !== undefined) {
    if (typeof query.after !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(query.after) || !Number.isFinite(Date.parse(query.after))) throw new ApiError(400, 'Invalid shared-file date');
    after = new Date(query.after).toISOString();
  }
  let cursor = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 1000 || !/^[\w-]+$/.test(query.cursor)) throw new Error();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (cursor.roomId !== roomId || cursor.kind !== kind || cursor.after !== after || !UUID.test(cursor.id) || typeof cursor.sequence !== 'string' || !/^\d{1,19}$/.test(cursor.sequence) || BigInt(cursor.sequence) > 9223372036854775807n) throw new Error();
    } catch { throw new ApiError(400, 'Invalid shared-file cursor'); }
  }
  return { kind, limit, after, cursor };
}
function mediaCursor(row, roomId, kind, after) {
  return Buffer.from(JSON.stringify({ roomId, kind, after, sequence: String(row.room_sequence), id: row.id })).toString('base64url');
}
module.exports = { parseMediaPage, mediaCursor, UUID };
