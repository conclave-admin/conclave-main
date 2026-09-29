const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = require('./app');
const env = require('./config/env');
const { connectRedis, redisClient } = require('./config/redis');
const { pool } = require('./config/db');
const presence = require('./services/presence.service');
const registerSocketHandlers = require('./sockets');

// Every rolling deploy, container restart and `docker compose down` delivers
// SIGTERM. Without a handler the process is killed mid-request: the HTTP server
// never closes, the pg pool and the three Redis connections are never drained,
// and sockets are cut without their presence state being cleaned up. These refs
// exist so shutdown can actually reach all of it.
let httpServer = null;
let io = null;
let pubClient = null;
let subClient = null;
let shuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 10000;

async function shutdown(signal) {
  // A second signal (or a hook timeout escalation) must not start a second,
  // interleaved teardown.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  // Nothing here may hang forever: the platform sends SIGKILL after its own
  // grace period, and being killed is worse than exiting with a non-zero code.
  const forceExit = setTimeout(() => {
    console.error('Shutdown exceeded its timeout, exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  if (forceExit.unref) forceExit.unref();

  try {
    // Stop the sweep before anything else so it cannot fire against clients
    // that are already being disconnected.
    presence.stopHeartbeatSweep();

    // io.close() disconnects every socket and, because the server was attached,
    // closes the underlying HTTP server too.
    if (io) await new Promise((resolve) => io.close(resolve));

    // Belt and braces in case the HTTP server outlived io.close().
    if (httpServer && httpServer.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }

    // All three Redis connections: the base client plus the pub/sub pair
    // created for the Socket.IO adapter.
    for (const client of [pubClient, subClient, redisClient]) {
      if (client && client.isOpen) await client.quit();
    }

    // Release pooled Postgres clients so the platform can finish the cycle.
    await pool.end();

    clearTimeout(forceExit);
    console.log('Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown', err);
    process.exit(1);
  }
}

async function main() {
  await connectRedis();

  httpServer = http.createServer(app);
  io = new Server(httpServer, {
    cors: { origin: env.clientOrigin, credentials: true },
  });

  // Wire up the Redis adapter for multi-instance pub/sub.
  // This lets io.to(roomId).emit() reach clients connected to
  // OTHER server instances via Redis — required for horizontal scaling.
  pubClient = redisClient.duplicate();
  subClient = redisClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  registerSocketHandlers(io);

  httpServer.listen(env.port, () => {
    console.log(`API + Socket.IO listening on http://localhost:${env.port}`);
  });
}

// Registered before main() so a signal arriving during startup is still caught.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
