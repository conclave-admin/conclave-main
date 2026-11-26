const test = require("node:test");
const assert = require("node:assert/strict");
const { parseByteRange } = require("../src/utils/byteRange");
const {
  validateParts,
  validateRequest,
  PART_SIZE,
} = require("../src/services/multipartUpload.service");
const { verifyFileSignature } = require("../src/utils/fileSignature");
test("single bounded, suffix and open ranges are correct; invalid or multi ranges are refused", () => {
  assert.deepEqual(parseByteRange("bytes=1-4", 10), {
    start: 1,
    end: 4,
    length: 4,
  });
  assert.deepEqual(parseByteRange("bytes=-3", 10), {
    start: 7,
    end: 9,
    length: 3,
  });
  assert.deepEqual(parseByteRange("bytes=8-", 10), {
    start: 8,
    end: 9,
    length: 2,
  });
  assert.deepEqual(parseByteRange("bytes=0-999", 10), {
    start: 0,
    end: 9,
    length: 10,
  });
  assert.equal(parseByteRange(null, 10), null);
  for (const range of [
    "bytes=10-",
    "bytes=4-1",
    "bytes=-0",
    "bytes=0-1,4-5",
    "bytes=-",
    "no",
    "bytes=9007199254740993-",
  ])
    assert.throws(() => parseByteRange(range, 10), { status: 416 });
});
test("multipart finalization validates authoritative part counts and sizes", () => {
  validateParts(
    [
      { PartNumber: 1, ETag: "one", Size: PART_SIZE },
      { PartNumber: 2, ETag: "two", Size: 3 },
    ],
    PART_SIZE + 3,
  );
  for (const parts of [
    [],
    [{ PartNumber: 2, ETag: "wrong", Size: PART_SIZE }],
    [{ PartNumber: 1, ETag: "one", Size: 1 }],
  ])
    assert.throws(() => validateParts(parts, PART_SIZE), { status: 400 });
});
test("session authorization validates IDs, per-type limits and display metadata", () => {
  const input = {
    roomId: "10000000-0000-4000-8000-000000000001",
    clientId: "20000000-0000-4000-8000-000000000001",
    filename: "file.pdf",
    mime_type: "application/pdf",
    size: 10,
  };
  assert.equal(validateRequest(input).mime_type, "application/pdf");
  assert.throws(() => validateRequest({ ...input, size: 26 * 1024 * 1024 }), {
    status: 413,
  });
  assert.throws(() => validateRequest({ ...input, roomId: "bad" }), {
    status: 400,
  });
});
test("magic byte validation refuses a spoofed image and recognizes PDF, PNG and UTF-8 text", async () => {
  await verifyFileSignature(
    Buffer.from("%PDF-1.4\nexample"),
    "application/pdf",
  );
  await verifyFileSignature(Buffer.from("A real text message"), "text/plain");
  await assert.rejects(
    verifyFileSignature(Buffer.from("<html>Not an image</html>"), "image/png"),
    { status: 415 },
  );
  await assert.rejects(
    verifyFileSignature(Buffer.from([0, 1, 2, 255]), "text/plain"),
    { status: 415 },
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  await verifyFileSignature(png, "image/png");
});
