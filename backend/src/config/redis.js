const { createClient } = require("redis");
const env = require("./env");

const DISABLE_DURATION_MS = 10 * 60 * 1000;
let disabledUntil = 0;
let ready = false;
let adapterClients = null;
let connectionAttempt = null;
let nextConnectionAttemptAt = 0;

function recordError(name, error) {
  const message = String(error?.message || error);
  if (message.includes("max requests limit exceeded"))
    disabledUntil = Date.now() + DISABLE_DURATION_MS;
  console.error(`[redis:${name}] ${message}`);
}

function configureClient(client, name, isMain = false) {
  client.on("ready", () => {
    if (isMain) ready = true;
  });
  client.on("reconnecting", () => {
    if (isMain) ready = false;
  });
  client.on("end", () => {
    if (isMain) ready = false;
  });
  client.on("error", (error) => recordError(name, error));
  return client;
}

function makeMainClient() {
  if (!env.redisUrl) return null;
  try {
    return configureClient(
      createClient({
        url: env.redisUrl,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: 5000,
          reconnectStrategy: (retries) =>
            Date.now() < disabledUntil
              ? false
              : Math.min(Math.max(retries, 1) * 2000, 30000),
        },
      }),
      "main",
      true,
    );
  } catch (error) {
    recordError("main", error);
    return null;
  }
}

const redisClient = makeMainClient();

async function connectWithTimeout(client, timeoutMs = 6000) {
  let timeout;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Redis connection timed out")),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function isRedisReady() {
  return Boolean(
    redisClient &&
      ready &&
      redisClient.isReady &&
      Date.now() >= disabledUntil,
  );
}

async function connectRedis() {
  if (!redisClient || Date.now() < disabledUntil) return false;
  if (isRedisReady()) return true;
  if (connectionAttempt) return connectionAttempt;
  if (Date.now() < nextConnectionAttemptAt) return false;
  connectionAttempt = (async () => {
    try {
      if (!redisClient.isOpen) await connectWithTimeout(redisClient);
      const connected = isRedisReady();
      nextConnectionAttemptAt = connected ? 0 : Date.now() + 30000;
      return connected;
    } catch (error) {
      recordError("main", error);
      nextConnectionAttemptAt = Date.now() + 30000;
      console.warn("[redis] unavailable, continuing without it");
      return false;
    } finally {
      connectionAttempt = null;
    }
  })();
  return connectionAttempt;
}

async function safe(fn, fallback = null) {
  if (!isRedisReady()) {
    if (redisClient && !redisClient.isOpen && Date.now() >= disabledUntil)
      await connectRedis();
    if (!isRedisReady()) return fallback;
  }
  try {
    return await fn(redisClient);
  } catch (error) {
    recordError("main", error);
    return fallback;
  }
}

function discardAdapterClients() {
  for (const client of [adapterClients?.pub, adapterClients?.sub]) {
    if (client?.isOpen) {
      try {
        Promise.resolve(client.disconnect()).catch((error) =>
          recordError("adapter-close", error),
        );
      } catch (error) {
        recordError("adapter-close", error);
      }
    }
  }
  adapterClients = null;
}

async function connectRedisAdapter() {
  if (!isRedisReady()) return null;
  if (!adapterClients) {
    const makeAdapterClient = (name) => {
      const client = configureClient(redisClient.duplicate(), name);
      const publish = client.publish.bind(client);
      client.publish = (...args) => {
        if (!isRedisReady() || !client.isReady) return Promise.resolve(0);
        return publish(...args).catch((error) => {
          recordError(name, error);
          return 0;
        });
      };
      return client;
    };
    adapterClients = {
      pub: makeAdapterClient("adapter-pub"),
      sub: makeAdapterClient("adapter-sub"),
    };
  }
  try {
    await Promise.all(
      [adapterClients.pub, adapterClients.sub].map(async (client) => {
        if (!client.isOpen) await connectWithTimeout(client);
      }),
    );
    if (
      !adapterClients.pub.isReady ||
      !adapterClients.sub.isReady ||
      !isRedisReady()
    ) {
      discardAdapterClients();
      return null;
    }
    return adapterClients;
  } catch (error) {
    recordError("adapter", error);
    discardAdapterClients();
    console.warn("[redis] Socket.IO adapter unavailable; using local adapter");
    return null;
  }
}

module.exports = {
  redisClient,
  connectRedis,
  connectRedisAdapter,
  isRedisReady,
  safe,
};
