const { createClient } = require("redis");
const env = require("./env");

const redisClient = createClient({ url: env.redisUrl });

redisClient.on("error", (err) => console.error("Redis client error", err));

// Call connectRedis() once at server startup (see server.js).
async function connectRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  return redisClient;
}

module.exports = { redisClient, connectRedis };
