import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

const HEADER = 'x-request-id';

// A generated id is a v4 UUID. An inbound one is accepted only if it looks
// like an opaque id: reasonable length, no control characters, no newlines.
// This is not paranoia -- an unvalidated header value ends up in log lines,
// and a value containing "\n" lets a caller forge fake log entries (log
// injection). It is also echoed in a response header, where CR/LF would allow
// header splitting.
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Attaches a request id to every request, and echoes it back to the client.
 *
 * Accepts an inbound `X-Request-Id` so a trace started upstream (a load
 * balancer, or the browser retrying) stays continuous. Generates one
 * otherwise.
 *
 * MUST BE FIRST in the middleware chain: everything downstream -- the request
 * logger, the error handler, the call to the Python service -- reads
 * `req.id`. A middleware mounted before this one has no id to log, so its
 * failures are the hardest ones to trace.
 */
export function requestId(req, res, next) {
  const inbound = req.get(HEADER);
  req.id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();

  // Echoed so a user can quote it from devtools, and so the frontend can put
  // it in an error report.
  res.set('X-Request-Id', req.id);

  // Bound once here; every downstream handler uses req.log and never has to
  // remember to include the id.
  req.log = logger.child({ requestId: req.id });

  next();
}
