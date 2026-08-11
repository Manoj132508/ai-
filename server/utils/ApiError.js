import { ERROR_CODES, isKnownErrorCode } from './errorCodes.js';

/**
 * An error we meant to produce.
 *
 * The distinction that matters is *operational* versus *programmer* error:
 *
 *   - Operational: the caller sent a bad file, the KB does not exist, the AI
 *     service is down. Expected, described by the taxonomy, safe to show.
 *   - Programmer: a TypeError, a null dereference, a bug. Unexpected, and its
 *     message may contain internals -- paths, queries, secrets.
 *
 * `ApiError` marks the first kind. The error handler shows its message to the
 * client verbatim, and replaces anything else with a generic 500. That single
 * rule is what stops a stack trace reaching a browser.
 */
export class ApiError extends Error {
  /**
   * @param {string} code    A key of ERROR_CODES.
   * @param {string} [message] Overrides the taxonomy default. Must be safe to display.
   * @param {object} [details] Field-level context, e.g. validation failures.
   */
  constructor(code, message, details) {
    if (!isKnownErrorCode(code)) {
      // Throwing here rather than defaulting is deliberate: a typo'd code
      // would otherwise become a silent 500 in production. This turns it
      // into an immediate, obvious failure in development and in tests.
      throw new Error(`ApiError constructed with unknown code "${code}"`);
    }

    const entry = ERROR_CODES[code];
    super(message ?? entry.message);

    this.name = 'ApiError';
    this.code = code;
    this.status = entry.status;
    this.details = details;
    this.isOperational = true;

    // Omit this constructor from the captured stack so the trace points at
    // the throw site, which is what you actually want when reading logs.
    Error.captureStackTrace?.(this, ApiError);
  }
}

/** Convenience factory: `throw notFound('KB_NOT_FOUND')`. */
export function apiError(code, message, details) {
  return new ApiError(code, message, details);
}
