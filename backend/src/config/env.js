require("dotenv").config();

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: process.env.PORT || 7000,
  trustProxyHops: Math.max(0, Number.parseInt(process.env.TRUST_PROXY_HOPS || "0", 10) || 0),
  beta: {
    signupsEnabled: process.env.BETA_SIGNUPS_ENABLED !== "false",
    maxActiveAccounts: Math.max(1, Number.parseInt(process.env.BETA_MAX_ACTIVE_ACCOUNTS || "250", 10) || 250),
    storageAlertGb: Math.max(0, Number.parseFloat(process.env.BETA_STORAGE_ALERT_GB || "50") || 0),
    storageUsdPerGbMonth: Math.max(0, Number.parseFloat(process.env.BETA_STORAGE_USD_PER_GB_MONTH || "0") || 0),
    storageMonthlyBudgetUsd: Math.max(0, Number.parseFloat(process.env.BETA_STORAGE_MONTHLY_BUDGET_USD || "0") || 0),
  },
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  mail: {
    encryptionKey: process.env.MAIL_ENCRYPTION_KEY,
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
    frontendUrl:
      process.env.APP_PUBLIC_URL ||
      process.env.CLIENT_ORIGIN ||
      "http://localhost:5173",
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
    allowedOrigins: (process.env.PUSH_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  },
  calls: {
    stunUrls: (process.env.RTC_STUN_URLS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    turnUrls: (process.env.RTC_TURN_URLS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    turnSharedSecret: process.env.RTC_TURN_SHARED_SECRET,
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
  r2: {
    directUploads: process.env.R2_DIRECT_UPLOADS_ENABLED === "true",
    cleanupIntervalMs: Math.max(
      60000,
      Number(process.env.MEDIA_CLEANUP_INTERVAL_MS) || 300000,
    ),
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    endpoint:
      process.env.R2_ENDPOINT ||
      (process.env.R2_ACCOUNT_ID
        ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        : undefined),
    previewWorkerUrl: process.env.R2_PREVIEW_WORKER_URL,
    previewSigningSecret: process.env.R2_PREVIEW_SIGNING_SECRET,
  },
};
