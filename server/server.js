import { createApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info('server listening', {
    port: config.port,
    environment: config.nodeEnv,
    corsOrigins: config.corsOrigins,
  });
});

/**
 * Graceful shutdown.
 *
 * A bare `process.exit()` on SIGTERM severs in-flight requests mid-response,
 * so a user's upload fails on every deploy. `server.close()` stops accepting
 * new connections and waits for open ones to finish.
 *
 * The timeout matters as much as the close: if a request is wedged, close()
 * never resolves and the process hangs until the supervisor SIGKILLs it. Ten
 * seconds is enough for a normal request and short enough not to stall a
 * rolling deploy.
 */
function shutdown(signal) {
  logger.info('shutdown initiated', { signal });

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  // Do not let this timer alone keep the event loop alive.
  forceExit.unref();

  server.close((err) => {
    if (err) {
      logger.error('error during shutdown', { message: err.message });
      process.exit(1);
    }
    // Phase 7 closes the Mongo connection here, before exiting.
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM')); // systemd, Docker
process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C

/**
 * Last-resort handlers.
 *
 * Reaching either of these means a bug escaped every catch, so the process
 * state is no longer trustworthy -- a half-finished operation may hold a lock
 * or a partially written record. The correct response is to log everything
 * and exit so the supervisor restarts a clean process. Swallowing these and
 * carrying on is how a server ends up quietly serving corrupt data.
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
