import { config } from '../config/env.js';

/**
 * Structured JSON logging to stdout.
 *
 * Two decisions worth defending:
 *
 * 1. JSON, not `console.log('user ' + id + ' failed')`. A log line is data.
 *    JSON means CloudWatch can filter on `requestId` or `code` without
 *    regex-parsing prose that changes every time someone rewords a message.
 *
 * 2. stdout, not a file. The process should not own log rotation, disk space
 *    or file handles. systemd captures stdout in production; the terminal
 *    captures it in development. Same code, no configuration.
 *
 * No pino or winston: this is ~30 lines, and the master plan says not to add
 * a dependency to look sophisticated. Structured transports become worth it
 * at the point we need sampling or multiple sinks.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = config.isProduction ? LEVELS.info : LEVELS.debug;

function emit(level, message, meta = {}) {
  if (LEVELS[level] < threshold) return;

  const line = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  // Errors and warnings go to stderr so they can be routed and alerted on
  // separately from ordinary traffic.
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),

  /**
   * Returns a logger bound to one request's id, so every line it writes is
   * attributable without each call site remembering to pass it.
   *
   * This is the whole point of the request id: one `grep` on a single value
   * reconstructs a request across Express *and* the Python service, which
   * receives the same id as X-Request-Id (section 2.6).
   */
  child(bindings) {
    return {
      debug: (message, meta) => emit('debug', message, { ...bindings, ...meta }),
      info: (message, meta) => emit('info', message, { ...bindings, ...meta }),
      warn: (message, meta) => emit('warn', message, { ...bindings, ...meta }),
      error: (message, meta) => emit('error', message, { ...bindings, ...meta }),
    };
  },
};
