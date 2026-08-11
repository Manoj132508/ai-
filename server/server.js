import { createApp } from './app.js';
import { config } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { logger } from './utils/logger.js';
import './models/index.js'; // register every schema before the first request

let server;

/**
 * Connect to MongoDB BEFORE listening.
 *
 * Mongoose buffers operations issued before the connection is ready, so the
 * app would appear to work either way -- until a bad URI turned every request
 * into a ten-second buffering timeout instead of an immediate, obvious
 * failure. Connecting first means a misconfigured database stops the process
 * at boot, where it belongs.
 */
async function start() {
  try {
    await connectDatabase();
  } catch (err) {
    logger.error('failed to connect to mongodb', {
      message: err.message,
      uri: config.mongodbUri.replace(/\/\/[^@]*@/, '//***:***@'), // never log credentials
    });
    process.exit(1);
  }

  server = createApp().listen(config.port, () => {
    logger.info('server listening', {
      port: config.port,
      environment: config.nodeEnv,
      corsOrigins: config.corsOrigins,
    });
  });
}

/**
 * Graceful shutdown, in dependency order: stop accepting requests, let
 * in-flight ones finish, and only then close the database.
 *
 * Closing Mongo first would fail every request that is still running.
 *
 * The timeout matters as much as the close: if a request is wedged,
 * `server.close()` never resolves and the process hangs until the supervisor
 * SIGKILLs it. Ten seconds is enough for a normal request and short enough
 * not to stall a rolling deploy.
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return; // a second Ctrl+C must not start a parallel shutdown
  shuttingDown = true;

  logger.info('shutdown initiated', { signal });

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      logger.info('http server closed');
    }

    await disconnectDatabase();
    logger.info('mongodb connection closed');

    clearTimeout(forceExit);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('error during shutdown', { message: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM')); // systemd, Docker
process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C

/**
 * Last-resort handlers.
 *
 * Reaching either means a bug escaped every catch, so process state is no
 * longer trustworthy -- a half-finished operation may hold a lock or a
 * partially written record. Log everything and exit so the supervisor
 * restarts a clean process. Swallowing these is how a server ends up quietly
 * serving corrupt data.
 */
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { message: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

start();
