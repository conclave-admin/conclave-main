const ApiError = require("../utils/ApiError");
const { createHash } = require("node:crypto");
const { isRedisReady, safe } = require("../config/redis");

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
  if (!isRedisReady()) {
    if (process.env.NODE_ENV === "production")
      throw new Error("Redis rate-limit store is unavailable");
    return consume(id, { windowMs, max });
  }
  const digest = createHash("sha256").update(id).digest("hex");
  const count = await safe(
    (client) =>
      client.eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return count",
        {
          keys: [
            `${process.env.RATE_LIMIT_KEY_PREFIX || "rate-limit"}:${digest}`,
          ],
          arguments: [String(windowMs)],
        },
      ),
    undefined,
  );
  if (count == null) throw new Error("Redis rate-limit command failed");
  return Number(count) <= max;
}

// Socket callers need a retryable status, just like HTTP callers, when the
// shared store fails. Never fall back to a per-process budget in production.
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
