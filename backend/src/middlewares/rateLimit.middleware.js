const ApiError = require("../utils/ApiError");
const { createHash } = require("node:crypto");
const { redisClient } = require("../config/redis");

const buckets = new Map();

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
      // Do not silently disable brute-force protection during a Redis outage.
      return next(
        new ApiError(503, "Request protection is temporarily unavailable."),
      );
    }
  };
}

async function consumeShared(id, { windowMs, max }) {
  if (!redisClient.isOpen) {
    if (process.env.NODE_ENV === "production")
      throw new Error("Redis rate-limit store is unavailable");
    return consume(id, { windowMs, max });
  }
  const digest = createHash("sha256").update(id).digest("hex");
  const count = await redisClient.eval(
    "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return count",
    {
      keys: [`${process.env.RATE_LIMIT_KEY_PREFIX || "rate-limit"}:${digest}`],
      arguments: [String(windowMs)],
    },
  );
  return Number(count) <= max;
}

rateLimit.consume = consume;
rateLimit.consumeShared = consumeShared;
module.exports = rateLimit;
