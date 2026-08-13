/**
 * Security response headers.
 *
 *   npm test
 *
 * These headers must be present on EVERY response, so the test asserts them on
 * a plain 404 -- a path that touches no database and no auth, proving the
 * headers come from the middleware chain itself rather than any one handler.
 * node:test + node:assert, ephemeral port, no framework and no DB.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

// Set before importing anything that reads config: env.js resolves once at load.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-used-here';
process.env.INTERNAL_API_KEY = 'test-internal-key';

const { createApp } = await import('../app.js');

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('security headers', () => {
  test('are present on every response, including a 404', async () => {
    const res = await fetch(`${baseUrl}/api/no-such-route`);
    assert.equal(res.status, 404, 'unmatched route so no handler is involved');

    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });

  test('do not advertise the framework (no X-Powered-By)', async () => {
    const res = await fetch(`${baseUrl}/api/no-such-route`);
    assert.equal(res.headers.get('x-powered-by'), null, 'x-powered-by must be disabled');
  });

  test('HSTS is NOT sent outside production (dev serves plain http)', async () => {
    // Sending HSTS in development would tell the browser to refuse
    // http://localhost for months. It is set only when isProduction.
    const res = await fetch(`${baseUrl}/api/no-such-route`);
    assert.equal(res.headers.get('strict-transport-security'), null);
  });
});
