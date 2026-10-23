const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { pool } = require("./config/db");
const { redisClient } = require("./config/redis");

const env = require("./config/env");
const routes = require("./routes");
const errorMiddleware = require("./middlewares/error.middleware");
const { fail } = require("./utils/apiResponse");

const app = express();

// The API is deployed behind one trusted Render/Vercel-facing proxy hop.
// Keep this explicit and configurable; trusting arbitrary forwarded headers
// would let callers rotate their apparent address to evade the auth limiter.
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0)
  app.set("trust proxy", proxyHops);

app.use(helmet());
app.use(
  cors({
    origin: env.clientOrigin,
    credentials: true,
    exposedHeaders: [
      "ETag",
      "Accept-Ranges",
      "Content-Range",
      "Content-Length",
    ],
  }),
);
app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));
// Cap JSON bodies. Attachments are uploaded as multipart to /upload, so
// message payloads stay small (BACKEND_TASKS.md Bug 14).
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Liveness stays dependency-free; readiness confirms both stores before a
// deployment receives traffic. Do not return connection strings or raw errors.
app.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    if (!redisClient.isReady) throw new Error("Redis is not ready");
    await redisClient.ping();
    return res.json({ status: "ready" });
  } catch {
    res.set("Retry-After", "5");
    return res.status(503).json({ status: "not_ready" });
  }
});

app.use("/api", routes);

// 404 for anything that matched no route. Without this Express falls through to
// its own default handler, which returns an HTML page — so a mistyped /api path
// gave the client a different content type and shape from every other response.
// Registered after the routers so it only catches genuinely-unmatched paths, and
// before errorMiddleware (which is 4-arg and only runs on thrown errors).
app.use((req, res) => fail(res, "Route not found", 404));

app.use(errorMiddleware);

module.exports = app;
