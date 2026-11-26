const ApiError = require("../utils/ApiError");
const { createHash } = require("node:crypto");
const { isRedisReady, safe } = require("../config/redis");
const { query } = require("../config/db");

const buckets = new Map();
let postgresCleanupRuns = 0;
let postgresCleanupActive = false;

function consume(id, { windowMs = 60_000, max = 30 } = {}) {
  const now = Date.now();
  let bucket = buckets.get(id);
  if (!bucket || bucket.resetAt <= now)
    bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  buckets.set(id, bucket);
  if (buckets.size > 5000)
    for (const [bucketId, value] of buckets)
      if (value.resetAt <= now) buckets.delete(bucketId);
  return bucket.count <= max;
}

function rateLimit({
  windowMs = 60_000,
  max = 30,
  key = (req) => req.user?.id || req.ip,
} = {}) {
  return async (req, _res, next) => {
    try {
      if (
        req.method === "OPTIONS" ||
        ["/health", "/healthz", "/ready"].includes(req.path) ||
        /\.[a-z0-9]{1,10}$/i.test(req.path)
      )
        return next();
      const dimensions = [].concat(key(req)).filter(Boolean);
      const scope = `${req.baseUrl}${req.path}`;
      for (const dimension of dimensions) {
        const id = `${scope}:${dimension}`;
        if (!(await consumeShared(id, { windowMs, max }))) {
          return next(
            new ApiError(429, "Too many requests. Please try again shortly."),
          );
        }
      }
      return next();
    } catch {
      return next(
        new ApiError(503, "Request protection is temporarily unavailable."),
      );
    }
  };
}

async function consumeShared(id, { windowMs = 60_000, max = 30 } = {}) {
  const digest = createHash("sha256").update(id).digest("hex");
  const key = `${process.env.RATE_LIMIT_KEY_PREFIX || "rate-limit"}:${digest}`;
  if (!isRedisReady()) {
    if (process.env.NODE_ENV === "production")
      return consumePostgres(key, windowMs, max);
    return consume(id, { windowMs, max });
  }
  const count = await safe(
    (client) =>
      client.eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return count",
        {
          keys: [key],
          arguments: [String(windowMs)],
        },
      ),
    undefined,
  );
  if (count == null) {
    if (process.env.NODE_ENV === "production")
      return consumePostgres(key, windowMs, max);
    throw new Error("Redis rate-limit command failed");
  }
  return Number(count) <= max;
}

// PostgreSQL is already required for authenticated requests, so it provides a
// shared production fallback when Redis is absent or temporarily unavailable.
// The upsert is atomic across API instances and only stores a hash of the
// endpoint/account/IP limiter key.
async function consumePostgres(key, windowMs, max) {
  const result = await query(
    `INSERT INTO request_rate_limit_buckets(bucket_key,request_count,reset_at)
     VALUES($1,1,NOW()+($2::double precision * INTERVAL '1 millisecond'))
     ON CONFLICT(bucket_key) DO UPDATE SET
       request_count=CASE
         WHEN request_rate_limit_buckets.reset_at<=NOW() THEN 1
         ELSE request_rate_limit_buckets.request_count+1
       END,
       reset_at=CASE
         WHEN request_rate_limit_buckets.reset_at<=NOW() THEN EXCLUDED.reset_at
         ELSE request_rate_limit_buckets.reset_at
       END
     RETURNING request_count`,
    [key, windowMs],
  );

  // A bounded sweep keeps the fallback table small without adding a cleanup
  // query to every rate-limited request.
  postgresCleanupRuns += 1;
  if (postgresCleanupRuns % 256 === 0 && !postgresCleanupActive) {
    postgresCleanupActive = true;
    query(
      `DELETE FROM request_rate_limit_buckets WHERE bucket_key IN (
         SELECT bucket_key FROM request_rate_limit_buckets
         WHERE reset_at<=NOW() ORDER BY reset_at LIMIT 500
       )`,
    )
      .catch((error) => console.error("[rate-limit] PostgreSQL bucket cleanup failed", error.code || error.name))
      .finally(() => { postgresCleanupActive = false; });
  }
  return Number(result.rows[0].request_count) <= max;
}

// Socket callers receive the same retryable response as HTTP callers only if
// both the configured shared store and PostgreSQL are unavailable.
async function requireShared(id, options, message) {
  let allowed;
  try {
    allowed = await consumeShared(id, options);
  } catch {
    throw new ApiError(503, "Request protection is temporarily unavailable.");
  }
  if (!allowed) throw new ApiError(429, message);
}

rateLimit.consume = consume;
rateLimit.consumeShared = consumeShared;
rateLimit.requireShared = requireShared;
module.exports = rateLimit;
