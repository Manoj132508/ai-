import { Router } from 'express';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ERROR_CODES } from '../utils/errorCodes.js';
import { ok } from '../utils/respond.js';

/**
 * Deliberate-failure routes. Mounted only when NODE_ENV !== 'production'
 * (see app.js) -- they must never be reachable on a deployed server.
 *
 * These exist because the error path is the part of an API least likely to be
 * exercised by hand and most likely to be wrong. Every branch of the handler
 * has a route that triggers it, so the whole taxonomy is verifiable in
 * seconds rather than by waiting for a real failure.
 */
const router = Router();

/** Lists every code so the taxonomy can be inspected without reading source. */
router.get('/error-codes', (req, res) =>
  ok(res, {
    codes: Object.entries(ERROR_CODES).map(([code, { status, message }]) => ({
      code,
      status,
      message,
    })),
  }),
);

/**
 * Throws a real ApiError for any code in the taxonomy.
 * Proves: code -> HTTP status mapping, and that operational messages are
 * shown to the client verbatim.
 */
router.get('/error/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!Object.hasOwn(ERROR_CODES, code)) {
    throw new ApiError('VALIDATION_ERROR', `Unknown error code "${code}".`, {
      known: Object.keys(ERROR_CODES),
    });
  }
  throw new ApiError(code);
});

/**
 * Synchronous throw inside a normal handler.
 * Proves: Express 4 catches synchronous throws by itself -- no wrapper needed.
 */
router.get('/throw-sync', () => {
  throw new ApiError('KB_NOT_FOUND');
});

/**
 * Rejected promise inside an asyncHandler-wrapped handler.
 * Proves: asyncHandler forwards the rejection to next(), so the error handler
 * runs and the client gets a response.
 */
router.get(
  '/throw-async',
  asyncHandler(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new ApiError('AI_SERVICE_UNAVAILABLE');
  }),
);

/**
 * The same rejection WITHOUT the wrapper.
 *
 * !! CALLING THIS ROUTE TERMINATES THE SERVER. That is the demonstration. !!
 *
 * Express 4 never observes the rejected promise, so three things happen:
 *
 *   1. next() is never called, no response is sent, and the request hangs
 *      until the client times out.
 *   2. Node emits `unhandledRejection`, which server.js treats as
 *      unrecoverable and shuts the process down.
 *   3. The hung connection keeps server.close() from completing, so the
 *      10-second force-exit timer is what actually ends the process.
 *
 * One missing wrapper takes down every other in-flight request too. This is
 * the whole reason asyncHandler exists.
 */
router.get('/throw-async-unwrapped', async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw new ApiError('AI_SERVICE_UNAVAILABLE');
});

/**
 * A plain Error carrying a message that looks like a leaked internal.
 * Proves: non-ApiError failures are replaced with the generic 500 text, so
 * nothing sensitive reaches the client, while the full detail is logged.
 */
router.get(
  '/throw-unknown',
  asyncHandler(async () => {
    throw new Error(
      'MongoServerError: connection to mongodb://admin:hunter2@10.0.1.14:27017 refused',
    );
  }),
);

/** Proves details survive to the client on a validation error. */
router.get('/throw-validation', () => {
  throw new ApiError('VALIDATION_ERROR', 'Some of the information sent was invalid.', {
    fields: { name: 'Name is required.', limit: 'Must be between 1 and 100.' },
  });
});

export default router;
