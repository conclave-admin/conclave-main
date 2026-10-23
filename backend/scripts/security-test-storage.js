// Explicit preload for the Phase 5 browser test process only. Bytes never leave
// memory and no real R2/SMTP/push provider is called by this fixture.
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");
const r2 = require("../src/config/r2");
const objects = new Map();
const object = (key) => {
  const found = objects.get(key);
  if (!found)
    throw Object.assign(new Error("No such object"), { name: "NoSuchKey" });
  return found;
};
r2.isConfigured = () => true;
r2.putObject = async ({ key, body, contentType }) => {
  if (
    contentType !== "application/vnd.conclave.encrypted" ||
    Buffer.from(body).subarray(0, 5).toString() !== "CCEF1" ||
    Buffer.from(body).includes(Buffer.from("SECRET DOCUMENT CONTENT"))
  )
    throw new Error("The browser sent plaintext to encrypted test storage");
  objects.set(key, {
    bytes: Buffer.from(body),
    type: contentType,
    etag: `"${createHash("sha256").update(body).digest("hex")}"`,
  });
};
r2.headObject = async (key) => {
  const row = object(key);
  return {
    ContentLength: row.bytes.length,
    ETag: row.etag,
    ContentType: row.type,
  };
};
r2.getObject = async (key, { range } = {}) => {
  const row = object(key);
  const match = /^bytes=(\d+)-(\d+)$/.exec(range || "");
  const bytes = match
    ? row.bytes.subarray(Number(match[1]), Number(match[2]) + 1)
    : row.bytes;
  return {
    Body: Readable.from(bytes),
    ContentLength: bytes.length,
    ETag: row.etag,
    ContentType: row.type,
  };
};
r2.deleteObject = async (key) => objects.delete(key);
r2.signedGetUrl = async () => {
  throw new Error("Encrypted media must use authenticated ciphertext delivery");
};
