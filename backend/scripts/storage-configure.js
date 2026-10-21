// Prints a reviewable merged configuration by default; --apply writes it to R2.
const { S3Client, GetBucketCorsCommand, PutBucketCorsCommand, GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand } = require('@aws-sdk/client-s3');
const env = require('../src/config/env');
const origins = (process.env.R2_ALLOWED_ORIGINS || env.clientOrigin).split(',').map((origin) => origin.trim()).filter(Boolean);
if (origins.some((origin) => !/^https?:\/\//.test(origin))) throw new Error('R2_ALLOWED_ORIGINS must contain explicit HTTP(S) origins');
const client = new S3Client({ region: 'auto', endpoint: env.r2.endpoint,
  credentials: { accessKeyId: env.r2.accessKeyId, secretAccessKey: env.r2.secretAccessKey }, requestChecksumCalculation: 'WHEN_REQUIRED' });
async function main() {
  const corsRule = { ID: 'conclave-private-media', AllowedOrigins: origins, AllowedMethods: ['PUT','GET','HEAD'],
    AllowedHeaders: ['content-type','content-length','range','if-range','if-match','x-amz-*'], ExposeHeaders: ['ETag','Content-Range','Accept-Ranges','Content-Length'], MaxAgeSeconds: 3600 };
  const lifecycleRule = { ID: 'conclave-abort-incomplete', Status: 'Enabled', Filter: { Prefix: 'conclave/attachments/' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } };
  if (process.argv.includes('--template')) {
    if (process.argv.includes('--apply')) throw new Error('Review templates separately before applying configuration');
    console.log(JSON.stringify({ bucket: env.r2.bucket, CORSRules: [corsRule], LifecycleRules: [lifecycleRule] }, null, 2));
    return;
  }
  let cors = []; let rules = [];
  try { cors = (await client.send(new GetBucketCorsCommand({ Bucket: env.r2.bucket }))).CORSRules || []; }
  catch (error) { if (!['NoSuchCORSConfiguration','NoSuchCORS'].includes(error.name)) throw error; }
  try { rules = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: env.r2.bucket }))).Rules || []; }
  catch (error) { if (error.name !== 'NoSuchLifecycleConfiguration') throw error; }
  cors = [...cors.filter((rule) => rule.ID !== corsRule.ID), corsRule];
  rules = [...rules.filter((rule) => rule.ID !== lifecycleRule.ID), lifecycleRule];
  console.log(JSON.stringify({ bucket: env.r2.bucket, CORSRules: cors, LifecycleRules: rules }, null, 2));
  if (process.argv.includes('--apply')) {
    await client.send(new PutBucketCorsCommand({ Bucket: env.r2.bucket, CORSConfiguration: { CORSRules: cors } }));
    await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket: env.r2.bucket, LifecycleConfiguration: { Rules: rules } }));
    console.log('R2 CORS and incomplete-upload lifecycle configured.');
  }
}
main().catch((error) => { console.error('Storage configuration failed', { code: error.name }); process.exitCode = 1; }).finally(() => client.destroy());
