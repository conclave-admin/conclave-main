const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const env = require("./env");

const { accessKeyId, secretAccessKey, bucket, endpoint } = env.r2;

function isConfigured() {
  return Boolean(accessKeyId && secretAccessKey && bucket && endpoint);
}

// Cloudflare R2 is S3-compatible but does not need the optional checksums newer
// AWS SDK releases add to uploads and reads.
const client = isConfigured()
  ? new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    })
  : null;

function requireClient() {
  if (!client) throw new Error("R2 is not configured");
  return client;
}

async function putObject({ key, body, contentType }) {
  return requireClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

function getObject(key, { range, ifMatch } = {}) {
  return requireClient().send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: range,
      IfMatch: ifMatch,
    }),
  );
}

function deleteObject(key) {
  return requireClient().send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key }),
  );
}

function signedGetUrl(
  key,
  { expiresIn = 3600, contentType, inline = false } = {},
) {
  return getSignedUrl(
    requireClient(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: inline ? "inline" : "attachment",
    }),
    { expiresIn },
  );
}

function headObject(key) {
  return requireClient().send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
}
async function createMultipart(key, contentType) {
  const result = await requireClient().send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    }),
  );
  return result.UploadId;
}
function signedPartUrl(key, uploadId, partNumber, size) {
  return getSignedUrl(
    requireClient(),
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: size,
    }),
    { expiresIn: 300 },
  );
}
async function listParts(key, uploadId) {
  const result = await requireClient().send(
    new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
  );
  return result.Parts || [];
}
function completeMultipart(key, uploadId, parts) {
  return requireClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })),
      },
    }),
  );
}
function abortMultipart(key, uploadId) {
  return requireClient().send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    }),
  );
}
module.exports = {
  headObject,
  createMultipart,
  signedPartUrl,
  listParts,
  completeMultipart,
  abortMultipart,
  isConfigured,
  putObject,
  getObject,
  deleteObject,
  signedGetUrl,
  bucket,
};
