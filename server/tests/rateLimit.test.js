/**
 * The fixed-window rate limiter.
 *
 *   npm test
 *
 * The limiter is a no-op under NODE_ENV=test when wired into the app (so the
 * auth suite can fire many requests from one loopback IP). To test the LOGIC we
 * therefore construct it directly with `enabled: true` and drive it with fake
 * req/res/next objects and an injected clock -- no server, no waiting on real
 * time, and no coupling to how it happens to be wired.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'unused';
process.env.INTERNAL_API_KEY = 'unused';

const { createRateLimiter } = await import('../middleware/rateLimit.js');

/** A minimal req/res/next triple that records what the middleware did. */
function harness(ip = '1.2.3.4') {
  const headers = {};
  const req = { ip, log: { warn() {} } };
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  const calls = { passed: 0, error: null };
  const next = (err) => { if (err) calls.error = err; else calls.passed += 1; };
  return { req, res, next, headers, calls };
}

describe('rate limiter', () => {
  test('allows up to max, then rejects with RATE_LIMITED (429)', () => {
    const limiter = createRateLimiter({ windowMs: 10_000, max: 2, enabled: true });

    const a = harness();
    limiter(a.req, a.res, a.next);
    limiter(a.req, a.res, a.next);
    assert.equal(a.calls.passed, 2, 'the first two pass');
    assert.equal(a.calls.error, null, 'no error yet');

    const b = harness();
    limiter(b.req, b.res, b.next);
    assert.equal(b.calls.passed, 0, 'the third does not pass through');
    assert.ok(b.calls.error, 'the third is rejected');
    assert.equal(b.calls.error.code, 'RATE_LIMITED');
    assert.equal(b.calls.error.status, 429);

    limiter.stop();
  });

  test('sets RateLimit headers and Retry-After on rejection', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, enabled: true });

    const ok = harness();
    limiter(ok.req, ok.res, ok.next);
    assert.equal(ok.headers['RateLimit-Limit'], '1');
    assert.equal(ok.headers['RateLimit-Remaining'], '0', 'one used, none left');
    assert.ok(Number(ok.headers['RateLimit-Reset']) > 0, 'seconds until reset');
    assert.equal(ok.headers['Retry-After'], undefined, 'no Retry-After while allowed');

    const blocked = harness();
    limiter(blocked.req, blocked.res, blocked.next);
    assert.ok(blocked.calls.error, 'rejected');
    assert.ok(Number(blocked.headers['Retry-After']) > 0, 'Retry-After present on 429');

    limiter.stop();
  });

  test('keys are independent: one IP hitting the limit does not affect another', () => {
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1, enabled: true });

    const attacker1 = harness('10.0.0.1');
    limiter(attacker1.req, attacker1.res, attacker1.next); // uses the one allowed
    const attacker1again = harness('10.0.0.1');
    limiter(attacker1again.req, attacker1again.res, attacker1again.next);
    assert.ok(attacker1again.calls.error, 'same IP is now limited');

    const victim = harness('10.0.0.2');
    limiter(victim.req, victim.res, victim.next);
    assert.equal(victim.calls.passed, 1, 'a different IP has its own budget');
    assert.equal(victim.calls.error, null);

    limiter.stop();
  });

  test('the window resets: after windowMs the counter starts fresh', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({
      windowMs: 1000,
      max: 1,
      enabled: true,
      now: () => clock,
    });

    const first = harness();
    limiter(first.req, first.res, first.next);
    assert.equal(first.calls.passed, 1);

    const blocked = harness();
    limiter(blocked.req, blocked.res, blocked.next);
    assert.ok(blocked.calls.error, 'second within the window is blocked');

    clock += 1001; // advance past the window

    const afterReset = harness();
    limiter(afterReset.req, afterReset.res, afterReset.next);
    assert.equal(afterReset.calls.passed, 1, 'a new window allows it again');
    assert.equal(afterReset.calls.error, null);

    limiter.stop();
  });

  test('when disabled it is a pass-through and sets no headers', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 0, enabled: false });
    const h = harness();
    limiter(h.req, h.res, h.next);
    limiter(h.req, h.res, h.next);
    assert.equal(h.calls.passed, 2, 'max:0 would block everything if it were active');
    assert.equal(h.calls.error, null);
    assert.equal(h.headers['RateLimit-Limit'], undefined, 'no headers when disabled');
  });
});
