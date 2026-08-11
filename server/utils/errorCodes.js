/**
 * The error taxonomy from architecture section 2.6.
 *
 * Every failure the client can see resolves to one of these codes. The point
 * is that the frontend switches on `error.code` -- a stable contract -- and
 * never on `error.message`, which is prose and will be reworded.
 *
 * Each entry maps a code to its HTTP status and a safe default message. The
 * message is written for a user, not a developer: it says what happened and,
 * where possible, what to do next. Never include internals.
 *
 * NOTE: `NO_RELEVANT_CONTEXT` from section 2.6 is deliberately absent. When
 * retrieval finds nothing above the score threshold, that is a successful
 * request with a legitimate answer ("I couldn't find this in your documents"),
 * returned as 200. Modelling it as an error would make the client treat a
 * correct, grounded refusal as a failure -- and would hide the single most
 * important behaviour in the product behind an error path.
 */
export const ERROR_CODES = Object.freeze({
  // --- Request shape -------------------------------------------------
  VALIDATION_ERROR: {
    status: 400,
    message: 'Some of the information sent was invalid.',
  },
  ROUTE_NOT_FOUND: {
    status: 404,
    message: 'That endpoint does not exist.',
  },
  // Distinct from FILE_TOO_LARGE: this is a JSON body exceeding the parser
  // limit, not an upload. Same 413, but the user-facing advice differs, and
  // conflating them would tell someone to shrink a file they never sent.
  PAYLOAD_TOO_LARGE: {
    status: 413,
    message: 'The request was too large to process.',
  },

  // --- Authentication and tenancy ------------------------------------
  AUTH_REQUIRED: {
    status: 401,
    message: 'You need to sign in to do that.',
  },
  AUTH_INVALID: {
    status: 401,
    message: 'Your session is no longer valid. Please sign in again.',
  },
  RATE_LIMITED: {
    status: 429,
    message: 'Too many requests. Please wait a moment and try again.',
  },

  // --- Resources ------------------------------------------------------
  // 404 rather than 403 for another user's resource, so the API never
  // confirms that it exists (see the IDOR discussion in phase 3).
  KB_NOT_FOUND: {
    status: 404,
    message: 'That knowledge base could not be found.',
  },
  DOC_NOT_FOUND: {
    status: 404,
    message: 'That document could not be found.',
  },
  // 409 Conflict, not 400: the request is well formed and the caller is
  // allowed to make it. The resource is simply in a state that cannot
  // satisfy it yet.
  KB_EMPTY: {
    status: 409,
    message: 'This knowledge base has no indexed documents yet. Upload one first.',
  },

  // --- Uploads ---------------------------------------------------------
  FILE_TOO_LARGE: {
    status: 413,
    message: 'That file is larger than the 10 MB limit.',
  },
  FILE_TYPE_UNSUPPORTED: {
    status: 415,
    message: 'Only PDF, TXT and Markdown files can be uploaded.',
  },
  // 422: the upload succeeded and the type is allowed, but the content
  // cannot be processed.
  FILE_NO_TEXT: {
    status: 422,
    message:
      'No readable text could be extracted. This file may be a scanned image rather than a text PDF.',
  },

  // --- Downstream services ---------------------------------------------
  AI_SERVICE_UNAVAILABLE: {
    status: 503,
    message: 'The document service is temporarily unavailable. Please try again shortly.',
  },
  LLM_UNAVAILABLE: {
    status: 503,
    message: 'The answering service is temporarily unavailable. Please try again shortly.',
  },
  LLM_RATE_LIMITED: {
    status: 429,
    message: 'The answering service is busy. Please try again in a moment.',
  },

  // --- Catch-all --------------------------------------------------------
  INTERNAL_ERROR: {
    status: 500,
    message: 'Something went wrong on our side.',
  },
});

/** True when `code` is part of the taxonomy. */
export function isKnownErrorCode(code) {
  return Object.hasOwn(ERROR_CODES, code);
}
