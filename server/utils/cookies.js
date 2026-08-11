import { randomBytes } from 'node:crypto';
import { config } from '../config/env.js';

export const SESSION_COOKIE = 'aika_session';
export const CSRF_COOKIE = 'aika_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Cookie attributes, defined once.
 *
 * THE BUG THIS PREVENTS: `res.clearCookie(name)` does not delete a cookie by
 * name. It sets the same cookie to an empty value with an expiry in the past —
 * and the browser only treats that as the *same cookie* if `path`, `domain`,
 * `secure` and `sameSite` all match the original. Clear it with different
 * options and the browser keeps the original: the user clicks "log out", gets
 * a success response, and stays logged in.
 *
 * That failure is invisible in development, where `secure` is false and paths
 * usually match by luck. It appears in production. Deriving set and clear from
 * one function makes the mismatch impossible rather than merely unlikely.
 */
function baseCookieOptions() {
  return {
    // Not readable by JavaScript, so an XSS payload cannot exfiltrate the
    // session (ADR 003).
    httpOnly: true,

    // HTTPS only in production. Cannot be true in development or the cookie
    // is silently dropped over plain http on localhost.
    secure: config.isProduction,

    // The browser will not attach this cookie to any cross-site request, so a
    // form or fetch from another origin arrives unauthenticated. This is the
    // first CSRF defence; the double-submit token is the second.
    sameSite: 'strict',

    path: '/',
  };
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    ...baseCookieOptions(),
    maxAge: config.jwtExpiresMs,
  });
}

/**
 * The CSRF half of the double-submit pair.
 *
 * Deliberately NOT httpOnly — the client must read it to echo it back in a
 * header. That is safe because the token is not a credential: knowing it
 * grants nothing. Its only job is to prove the request came from a page that
 * could read our cookie, which the same-origin policy denies to an attacker's
 * site.
 */
export function setCsrfCookie(res) {
  const token = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    ...baseCookieOptions(),
    httpOnly: false,
    maxAge: config.jwtExpiresMs,
  });
  return token;
}

/**
 * Clears both cookies using attributes matching those they were set with.
 *
 * `maxAge` is intentionally omitted: express sets its own past expiry, and
 * passing a maxAge here would fight it.
 */
export function clearAuthCookies(res) {
  const { ...options } = baseCookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
  res.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}
