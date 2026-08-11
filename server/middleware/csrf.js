import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../utils/ApiError.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../utils/cookies.js';

/**
 * Double-submit cookie CSRF protection.
 *
 * WHY COOKIE AUTH NEEDS THIS AT ALL
 *
 * The browser attaches our session cookie to requests it makes on our behalf —
 * including ones initiated by another site. A form on evil.example that POSTs
 * to our API would carry the victim's session. That is the whole CSRF class,
 * and it exists *because* cookies are automatic. A bearer token in a header
 * would not have the problem, but would be readable by XSS instead (ADR 003).
 *
 * HOW DOUBLE-SUBMIT WORKS
 *
 * On login we set a second, non-httpOnly cookie holding a random token. The
 * client reads it and echoes it in the X-CSRF-Token header on every unsafe
 * request. We require the two to match.
 *
 * An attacker's page cannot do this. The same-origin policy stops it reading
 * our cookie, so it cannot produce the header — and the browser will not let
 * a cross-origin page set that header on a "simple" request either. It can
 * still *send* the cookie; it just cannot know what is in it.
 *
 * LAYERED WITH SameSite=Strict
 *
 * SameSite=Strict already stops the cookie being attached cross-site, so in a
 * modern browser it alone blocks this. Double-submit is the second layer,
 * because SameSite is a browser-enforced policy: it is not applied by
 * non-browser clients, and its handling has varied across browser versions.
 * A defence with one layer is a defence that fails completely when that layer
 * has a gap.
 */

// Methods that do not change state need no token. This is not laziness: a GET
// that mutates is the actual bug, and CSRF-protecting it would hide it.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so the length check has to come
  // first — and it necessarily leaks length, which is fine for a random token
  // of fixed size.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireCsrfToken(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);

  if (!cookieToken || !headerToken || !safeCompare(cookieToken, headerToken)) {
    return next(new ApiError('CSRF_INVALID'));
  }

  return next();
}
