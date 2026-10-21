const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMediaMetadata: validate } = require('../src/utils/mediaMetadata');
const thumbnail = 'data:image/jpeg;base64,/9j/2Q==';
test('optional display metadata is bounded and preserves image and video fields', () => {
  assert.deepEqual(validate(), { width: null, height: null, preview_url: null, duration: null });
  assert.deepEqual(validate(JSON.stringify({ width: 1920, height: 1080, preview_url: thumbnail, duration: 12.5 }), 'video/mp4'),
    { width: 1920, height: 1080, preview_url: thumbnail, duration: 12.5 });
});
test('metadata rejects active URLs, malformed thumbnails, oversized payloads and invalid dimensions', () => {
  for (const value of [null, 'data:image/svg+xml;base64,PHN2Zz4=', 'https://example.test/a.jpg', 'data:image/jpeg;base64,aGVsbG8=',
    `data:image/jpeg;base64,${'A'.repeat(17000)}`]) {
    if (value === null) continue;
    assert.throws(() => validate({ preview_url: value }, 'image/jpeg'), { status: 400 });
  }
  for (const value of [{ width: -1, height: 2 }, { width: 32769, height: 1 }, { width: 1 }, { width: 2.2, height: 2 },
    { duration: Infinity }, { duration: -1 }, { duration: 604801 }]) assert.throws(() => validate(value, 'video/mp4'), { status: 400 });
  assert.throws(() => validate('{bad', 'image/jpeg'), { status: 400 });
  assert.throws(() => validate({ preview_url: thumbnail }, 'application/pdf'), { status: 400 });
  assert.throws(() => validate({ duration: 1 }, 'image/jpeg'), { status: 400 });
});


test('multipart failures report the correct size limit and malformed field errors', () => {
  const middleware = require('../src/middlewares/error.middleware');
  let status; let body;
  const response = { status(value) { status = value; return this; }, json(value) { body = value; } };
  middleware({ name: 'MulterError', code: 'LIMIT_FILE_SIZE' }, {}, response, () => {});
  assert.equal(status, 413); assert.match(body.message, /50MB/);
  middleware({ name: 'MulterError', code: 'LIMIT_FIELD_VALUE', message: 'Field value too long' }, {}, response, () => {});
  assert.equal(status, 400); assert.equal(body.message, 'Field value too long');
});
