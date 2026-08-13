import { config } from '../config/env.js';

/**
 * Security response headers.
 *
 * These are cheap, static headers that harden every response. None of them do
 * anything on their own for a machine-to-machine JSON client; they matter the
 * moment a *browser* is involved -- either our SPA, or a browser that an
 * attacker has tricked into treating an API response as something it is not.
 *
 * Each header is a specific, named defence. A blanket "add helmet" would set
 * all of these and a dozen more, several of which are meaningless for a
 * JSON-only API (they configure how HTML/scripts load). Setting the exact set
 * we can justify is the point of this phase -- every line is defensible.
 *
 * =====================================================================
 * WHY EACH ONE
 * =====================================================================
 *
 * X-Content-Type-Options: nosniff
 *   Stops a browser from second-guessing our Content-Type. Without it, a
 *   browser may "sniff" a response body and decide a text/plain upload is
 *   actually HTML, then execute its <script>. `nosniff` forces it to trust the
 *   declared type, so our application/json stays inert.
 *
 * X-Frame-Options: DENY
 *   Clickjacking. Forbids any site from loading our responses inside a
 *   <frame>/<iframe>. An attacker cannot overlay a transparent frame of our UI
 *   on their page and trick a logged-in user into clicking something.
 *
 * Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'
 *   The API returns JSON, never HTML, so nothing should ever load *from* an API
 *   response. `default-src 'none'` means: if a browser is somehow induced to
 *   render one of these responses as a document, no script, image, style, or
 *   fetch it references is allowed to load. `frame-ancestors 'none'` is the
 *   modern equivalent of X-Frame-Options (we send both, because older browsers
 *   honour only the latter). This is a backstop, not the primary control -- the
 *   SPA served by Vite/the CDN has its own, richer CSP.
 *
 * Referrer-Policy: no-referrer
 *   API URLs can carry ids in the path. `no-referrer` stops the browser
 *   attaching our URL as the Referer header on any request the response
 *   triggers, so those ids never leak to a third-party host.
 *
 * Cross-Origin-Resource-Policy: same-origin
 *   Tells the browser not to let other origins embed our responses as a
 *   resource. Combined with our credentialed CORS allowlist, it keeps
 *   authenticated JSON from being pulled into a foreign page.
 *
 * Strict-Transport-Security (production only)
 *   Forces HTTPS for max-age seconds, including after a single visit. It is set
 *   ONLY in production: sending it in development -- where we serve plain http
 *   on localhost -- would tell the browser to refuse http://localhost for
 *   months, which is a self-inflicted outage. It also only has meaning once a
 *   response is actually served over TLS.
 */

// Six months. Long enough to matter, short enough that a misconfiguration is
// not effectively permanent. `includeSubDomains` extends the guarantee to
// every subdomain; we deliberately omit `preload` (submitting to the browser
// preload list is a hard-to-reverse commitment that belongs to ops, not code).
const HSTS_VALUE = 'max-age=15552000; includeSubDomains';

const CSP_VALUE = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP_VALUE);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', HSTS_VALUE);
  }

  next();
}
