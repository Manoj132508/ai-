import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../utils/errorCodes.js';
import { config } from '../config/env.js';

/**
 * The single place a client-visible failure is produced.
 *
 * Express identifies an error handler by ARITY: it must declare four
 * parameters. Drop `next` because it looks unused and Express silently treats
 * this as ordinary middleware -- it stops receiving errors, every failure
 * falls through to Express's default HTML handler, and the bug is invisible
 * until something throws in production. `_next` keeps the arity while making
 * the non-use explicit.
 */
/**
 * Translates errors thrown by third-party middleware into the taxonomy.
 *
 * Middleware we did not write throws its own error shapes. `express.json()`
 * raises a SyntaxError tagged `entity.parse.failed` when a client sends
 * malformed JSON. Untranslated, that reaches the generic branch below and
 * becomes a 500 -- which tells the caller *we* failed when in fact *they*
 * sent a broken body. Beyond being wrong, it inflates the server-error rate
 * and pages someone on-call for a user's typo.
 *
 * Only shapes we recognise are mapped. Anything unrecognised must still fall
 * through to the 500 branch: guessing that an unknown error is the client's
 * fault would hide real bugs behind 4xx responses nobody investigates.
 */
function normaliseKnownError(err) {
  if (err instanceof ApiError) return err;

  // body-parser tags its errors with `type`.
  if (err?.type === 'entity.parse.failed') {
    return new ApiError('VALIDATION_ERROR', 'The request body is not valid JSON.');
  }
  if (err?.type === 'entity.too.large') {
    return new ApiError('PAYLOAD_TOO_LARGE');
  }

  // multer signals limit violations with its own MulterError codes. Without
  // translation an oversized upload is a 500 — telling the user we broke,
  // when in fact we correctly refused a file that was too big.
  if (err?.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return new ApiError('FILE_TOO_LARGE');
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return new ApiError('VALIDATION_ERROR', 'Upload one file at a time, in the "file" field.');
    }
    return new ApiError('VALIDATION_ERROR', 'That upload could not be processed.');
  }

  return err;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(rawError, req, res, _next) {
  const err = normaliseKnownError(rawError);
  /*
   * Headers already sent -- the mid-stream case from architecture 2.3.
   *
   * Once a response has begun (SSE tokens are already flowing to the browser)
   * the status code and headers are gone; there is no way to turn a 200 into
   * a 503. Attempting to send another response throws
   * ERR_HTTP_HEADERS_SENT and masks the original error.
   *
   * Delegating to Express's default handler destroys the socket, which the
   * client observes as a broken stream -- the correct signal. The route that
   * owns the stream is responsible for emitting an SSE `error` event before
   * this point; this is the backstop, not the mechanism.
   */
  if (res.headersSent) {
    req.log?.error('error after response started', {
      code: err.code,
      message: err.message,
      path: req.originalUrl,
    });
    return _next(err);
  }

  const isOperational = err instanceof ApiError;

  // An operational error is one we described in the taxonomy and meant to
  // produce, so its message is safe to show. Anything else is a bug, and its
  // message may contain a file path, a query, or a secret -- so it is
  // replaced wholesale with the generic 500 text. This single branch is what
  // keeps internals out of responses.
  const code = isOperational ? err.code : 'INTERNAL_ERROR';
  const status = isOperational ? err.status : ERROR_CODES.INTERNAL_ERROR.status;
  const message = isOperational ? err.message : ERROR_CODES.INTERNAL_ERROR.message;

  // Log the *full* error server-side, always, including the stack. The client
  // gets a sanitised view; the operator gets everything, keyed by request id.
  const log = req.log ?? console;
  const logPayload = {
    code,
    status,
    method: req.method,
    path: req.originalUrl,
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
  };

  if (isOperational) {
    // Expected failures are warnings. Paging someone because a user uploaded
    // a 12 MB file would train them to ignore the alerts.
    log.warn('request failed', logPayload);
  } else {
    log.error('unhandled error', { ...logPayload, stack: err.stack });
  }

  const body = {
    success: false,
    data: null,
    error: {
      code,
      message,
      // requestId in the payload as well as the header, so a user pasting a
      // screenshot into a support message brings the trace key with them.
      requestId: req.id,
      ...(isOperational && err.details ? { details: err.details } : {}),
    },
  };

  // Stack traces in development only, and never for operational errors --
  // there is nothing to debug in a deliberate 404.
  if (!config.isProduction && !isOperational) {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
}
