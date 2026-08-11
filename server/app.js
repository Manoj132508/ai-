import express from 'express';
import cors from 'cors';

import { config } from './config/env.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';

/**
 * Builds the Express app WITHOUT starting a listener.
 *
 * Separating this from server.js is what makes Phase 12 possible: Supertest
 * takes the app object directly, so integration tests run against the real
 * middleware chain without binding a port. Tests then run in parallel and
 * never collide on 4200.
 *
 * =====================================================================
 * MIDDLEWARE ORDER
 *
 * Express runs middleware in registration order. This sequence is a set of
 * dependencies, not a style preference -- each note says what breaks if the
 * entry moves.
 * =====================================================================
 */
export function createApp() {
  const app = express();

  // 1. TRUST PROXY -- before anything reads req.ip or req.protocol.
  //    In production nginx terminates TLS, so without this every request
  //    appears to come from 127.0.0.1 over http. That silently breaks
  //    IP-based rate limiting (phase 11): every user shares one bucket.
  if (config.isProduction) {
    app.set('trust proxy', 1);
  }

  // 2. REQUEST ID -- must be first of the real middleware.
  //    Attaches req.id and req.log. Everything below reads them; anything
  //    mounted above this line logs without a trace key, which makes its
  //    failures the hardest to diagnose.
  app.use(requestId);

  // 3. REQUEST LOGGER -- immediately after the id.
  //    Starts the timer here so the measured duration covers body parsing and
  //    routing, not just the handler. Placed after requestId because it uses
  //    req.log.
  app.use(requestLogger);

  // 4. CORS -- before routes, because a browser preflight is an OPTIONS
  //    request that must be answered before the real one is sent.
  //    `credentials: true` is required for the httpOnly auth cookie (ADR 003)
  //    and is why `origin` is an explicit allowlist: the CORS spec forbids
  //    credentials with a wildcard, and accepting any origin with cookies
  //    would hand every site on the internet an authenticated session.
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );

  // 5. BODY PARSING -- after CORS, before routes.
  //    A handler cannot read req.body before this runs. The size limit is a
  //    denial-of-service control: without it a single request can buffer
  //    unbounded JSON into memory. File uploads do NOT come through here --
  //    they are multipart and get a streaming parser in phase 9.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  // 6. ROUTES.
  app.use('/api', routes);

  // 7. NOT FOUND -- after every route.
  //    Only reached when nothing above matched. Mounted earlier it would
  //    intercept legitimate requests.
  app.use(notFound);

  // 8. ERROR HANDLER -- last, always.
  //    Express only sends errors to handlers registered *after* the code that
  //    threw. Mounted before the routes it would never receive anything, and
  //    failures would fall through to Express's default HTML error page.
  app.use(errorHandler);

  return app;
}
