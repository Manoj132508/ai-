import mongoose from 'mongoose';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

/**
 * MongoDB connection lifecycle.
 *
 * Mongoose keeps one connection pool per process and buffers operations issued
 * before it is ready, so models can be imported at module load and used once
 * `connectDatabase()` resolves.
 */

let listenersAttached = false;

function attachConnectionListeners() {
  if (listenersAttached) return; // --watch restarts would otherwise stack these
  listenersAttached = true;

  const conn = mongoose.connection;

  conn.on('connected', () => {
    logger.info('mongodb connected', { database: conn.name });
  });

  // Fires for errors *after* the initial connection -- a dropped primary, an
  // auth failure on reconnect. Logged rather than thrown: mongoose retries on
  // its own, and throwing here would take down a process that is about to
  // recover.
  conn.on('error', (err) => {
    logger.error('mongodb error', { message: err.message });
  });

  conn.on('disconnected', () => {
    logger.warn('mongodb disconnected');
  });

  conn.on('reconnected', () => {
    logger.info('mongodb reconnected');
  });
}

export async function connectDatabase() {
  attachConnectionListeners();

  // Reject queries using fields absent from the schema, rather than silently
  // matching nothing. `{ userId: x, tenantId: y }` with a typo'd second field
  // would otherwise return another user's document.
  mongoose.set('strictQuery', true);

  /*
   * autoIndex: Mongoose issues createIndex for every declared index on
   * startup. Convenient in development; dangerous in production, where
   * building an index on a large collection blocks and can stall the app
   * during a deploy. In production indexes are created deliberately, as a
   * migration step, and the application asserts rather than builds.
   */
  mongoose.set('autoIndex', !config.isProduction);

  await mongoose.connect(config.mongodbUri, {
    // Default is 30s. That means a wrong URI leaves the process hanging for
    // half a minute before reporting anything. Five seconds fails fast enough
    // to be obvious while tolerating a slow local start.
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 10,
  });

  return mongoose.connection;
}

export async function disconnectDatabase() {
  // `false` = do not force. In-flight operations finish first, which is the
  // point of a graceful shutdown.
  await mongoose.connection.close(false);
}

/**
 * A real liveness check, not a state flag.
 *
 * `readyState === 1` only means the driver believes it is connected. It stays
 * 1 for some time after the server becomes unreachable, so a health endpoint
 * built on it reports healthy while every query fails. An admin `ping` is an
 * actual round trip.
 *
 * Raced against a timeout so a wedged connection cannot hang the health
 * endpoint itself -- a monitoring check that never returns is worse than one
 * that returns "unhealthy".
 */
export async function pingDatabase(timeoutMs = 1_000) {
  const startedAt = process.hrtime.bigint();

  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return { status: 'down', reason: 'not connected' };
  }

  try {
    await Promise.race([
      mongoose.connection.db.admin().command({ ping: 1 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ping timed out')), timeoutMs).unref(),
      ),
    ]);

    return {
      status: 'ok',
      latencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
    };
  } catch (err) {
    return { status: 'down', reason: err.message };
  }
}
