import { ApiError } from '../utils/ApiError.js';
import { config } from '../config/env.js';

/**
 * A fixed-window, in-memory rate limiter.
 *
 * WHAT IT DOES
 *
 * For each client (keyed by IP) it counts requests inside a fixed time window.
 * Up to `max` requests pass; the next one is rejected with 429 RATE_LIMITED
 * until the window rolls over. Every response carries RateLimit-* headers so a
 * well-behaved client can back off before it is ever refused.
 *
 * WHY FIXED WINDOW (and its one flaw)
 *
 * Fixed window is the simplest correct algorithm: one counter and one reset
 * time per key. Its known weakness is the boundary burst -- a client can send
 * `max` requests at the end of one window and `max` more at the start of the
 * next, so up to 2*max land in a short span. That is acceptable here because
 * these limits are abuse controls, not billing meters; the alternative (a
 * sliding-log or token bucket) costs more memory and code for a guarantee we
 * do not need. The choice is recorded in ADR 012.
 *
 * WHY IN-MEMORY (and the scale path)
 *
 * The counters live in this process's memory. That is correct for a single
 * instance and wrong the moment there are two: each replica would keep its own
 * counts, so N replicas mean an effective limit of N*max, and a restart clears
 * every counter. The fix is a shared store (Redis with INCR + EXPIRE), which is
 * a drop-in replacement for the Map below -- the middleware contract does not
 * change. Documented in ADR 012 so the limitation is a known trade-off, not a
 * surprise in production.
 *
 * WHY HAND-ROLLED
 *
 * express-rate-limit is the usual choice and a fine one. This is written out
 * instead because it is ~40 lines, every one of which is defensible in an
 * interview, and it avoids a dependency for logic this small. The escape hatch
 * (a Redis store) is the same one the library would need at scale anyway.
 *
 * @param {object}   opts
 * @param {number}   opts.windowMs  Window length in milliseconds.
 * @param {number}   opts.max       Requests allowed per key per window.
 * @param {string}   [opts.name]    Label for logs.
 * @param {boolean}  [opts.enabled] Defaults to false under NODE_ENV=test (see
 *                                   below); pass true to exercise it in a unit
 *                                   test.
 * @param {() => number} [opts.now] Clock injection point, so tests can advance
 *                                   time without sleeping. Defaults to Date.now.
 */
export function createRateLimiter({
  windowMs,
  max,
  name = 'rate-limit',
  enabled = !config.isTest,
  now = Date.now,
} = {}) {
  // key -> { count, resetAt }
  const buckets = new Map();

  // An unbounded Map keyed by client IP is itself a denial-of-service vector:
  // a spray of distinct source addresses would grow it without limit. A
  // periodic sweep drops windows that have already expired. It is unref'd so it
  // never keeps the process (or a test run) alive on its own, and it is only
  // created when the limiter is actually active.
  let sweeper;
  if (enabled) {
    sweeper = setInterval(() => {
      const t = now();
      for (const [key, bucket] of buckets) {
        if (t >= bucket.resetAt) buckets.delete(key);
      }
    }, windowMs);
    sweeper.unref?.();
  }

  function middleware(req, res, next) {
    // Disabled under test: the integration suite fires many requests from one
    // loopback IP, which any real limit would reject. The limiting logic is
    // covered directly in tests/rateLimit.test.js with enabled:true.
    if (!enabled) return next();

    // req.ip is only trustworthy because `trust proxy` is set in production
    // (see app.js); without it every request behind the proxy shares one IP
    // and therefore one bucket.
    const key = req.ip ?? 'unknown';
    const t = now();

    let bucket = buckets.get(key);
    if (!bucket || t >= bucket.resetAt) {
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    const resetSeconds = Math.max(0, Math.ceil((bucket.resetAt - t) / 1000));

    // IETF draft RateLimit headers: the limit, what's left, and seconds until
    // reset. A client that reads these can slow down before being refused.
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (bucket.count > max) {
      // Retry-After is the standard, machine-readable "come back in N seconds".
      res.setHeader('Retry-After', String(resetSeconds));
      req.log?.warn('rate limit exceeded', {
        limiter: name,
        key,
        count: bucket.count,
        limit: max,
      });
      // Flows through the existing error handler as a 429 in the {success,
      // data, error} envelope -- RATE_LIMITED was reserved in the taxonomy for
      // exactly this.
      return next(new ApiError('RATE_LIMITED'));
    }

    return next();
  }

  // Test affordances: clear counters between cases, and stop the sweeper so a
  // suite does not accumulate timers.
  middleware.reset = () => buckets.clear();
  middleware.stop = () => {
    if (sweeper) clearInterval(sweeper);
  };
  return middleware;
}
