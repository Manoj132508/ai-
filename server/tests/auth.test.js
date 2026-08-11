/**
 * Authentication and tenancy isolation.
 *
 *   npm test
 *
 * Uses node:test and node:assert — no test framework dependency. The app is
 * started on an ephemeral port (`listen(0)`), which is why app.js exports a
 * factory instead of listening itself: tests never collide with the dev
 * server on 4200 and can run in parallel.
 *
 * A SEPARATE DATABASE is used, wiped before the run. Pointing tests at the
 * development database is how someone loses their seed data, and worse, how a
 * test starts passing because of data a previous run left behind.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Must be set BEFORE importing anything that reads config, because
// config/env.js resolves process.env once at module load.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/ai_knowledge_assistant_test';
process.env.JWT_SECRET = randomBytes(32).toString('base64url');
process.env.INTERNAL_API_KEY = 'test-internal-key';

const { createApp } = await import('../app.js');
const { connectDatabase, disconnectDatabase } = await import('../config/db.js');
const mongoose = (await import('mongoose')).default;
await import('../models/index.js');
const { hashPassword } = await import('../utils/password.js');
const { User, KnowledgeBase } = await import('../models/index.js');

let server;
let baseUrl;

/** Minimal cookie jar: enough to behave like one browser session. */
function makeClient() {
  const jar = new Map();

  return {
    cookies: jar,

    csrf() {
      return jar.get('aika_csrf');
    },

    async request(method, path, { body, headers = {}, withCsrf = true } = {}) {
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const token = jar.get('aika_csrf');

      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          ...(withCsrf && token ? { 'x-csrf-token': token } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });

      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }

      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    },

    get(path, opts) { return this.request('GET', path, opts); },
    post(path, body, opts) { return this.request('POST', path, { body, ...opts }); },
  };
}

before(async () => {
  await connectDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase();
});

// ---------------------------------------------------------------------------

describe('registration', () => {
  test('creates an account, sets both cookies, and never returns the hash', async () => {
    const c = makeClient();
    const res = await c.post('/api/auth/register', {
      email: 'Alice@Example.Test', // deliberately mixed case
      password: 'correct-horse-battery',
      name: 'Alice',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.user.email, 'alice@example.test', 'email is normalised');

    assert.ok(c.cookies.has('aika_session'), 'session cookie set');
    assert.ok(c.cookies.has('aika_csrf'), 'csrf cookie set');

    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes('passwordHash'), 'no passwordHash key');
    assert.ok(!serialised.includes('$2a$') && !serialised.includes('$2b$'), 'no bcrypt digest');
  });

  test('the session cookie is httpOnly and SameSite=Strict; the csrf cookie is readable', async () => {
    const c = makeClient();
    const res = await c.post('/api/auth/register', {
      email: 'flags@example.test',
      password: 'correct-horse-battery',
      name: 'Flags',
    });

    const setCookies = res.headers.getSetCookie();
    const session = setCookies.find((v) => v.startsWith('aika_session='));
    const csrf = setCookies.find((v) => v.startsWith('aika_csrf='));

    assert.match(session, /HttpOnly/i, 'session is httpOnly');
    assert.match(session, /SameSite=Strict/i, 'session is SameSite=Strict');
    assert.match(session, /Path=\//i);
    // secure is false outside production, or the cookie would be dropped on
    // plain http in development.
    assert.ok(!/Secure/i.test(session), 'not Secure outside production');

    assert.ok(!/HttpOnly/i.test(csrf), 'csrf cookie must be readable by the client');
  });

  test('rejects a duplicate email with 409', async () => {
    const c = makeClient();
    const payload = { email: 'dupe@example.test', password: 'correct-horse-battery', name: 'D' };
    await c.post('/api/auth/register', payload);

    const res = await makeClient().post('/api/auth/register', payload);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_TAKEN');
  });

  test('rejects a short password with 400 and field details', async () => {
    const res = await makeClient().post('/api/auth/register', {
      email: 'short@example.test',
      password: 'abc',
      name: 'S',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.details.fields.password);
  });
});

describe('login', () => {
  before(async () => {
    await User.create({
      email: 'bob@example.test',
      name: 'Bob',
      passwordHash: await hashPassword('bob-password-123'),
    });
  });

  test('succeeds with correct credentials', async () => {
    const c = makeClient();
    const res = await c.post('/api/auth/login', {
      email: 'bob@example.test',
      password: 'bob-password-123',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.name, 'Bob');
  });

  test('wrong password and unknown email give the SAME 401 and message', async () => {
    const wrongPassword = await makeClient().post('/api/auth/login', {
      email: 'bob@example.test',
      password: 'not-bobs-password',
    });
    const unknownEmail = await makeClient().post('/api/auth/login', {
      email: 'nobody@example.test',
      password: 'not-bobs-password',
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    // Identical responses: a different message would be an account-existence
    // oracle for anyone probing the endpoint.
    assert.equal(wrongPassword.body.error.code, unknownEmail.body.error.code);
    assert.equal(wrongPassword.body.error.message, unknownEmail.body.error.message);
  });
});

describe('session lifecycle', () => {
  test('/me is 401 without a cookie, 200 with one, 401 again after logout', async () => {
    const anonymous = await makeClient().get('/api/auth/me');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTH_REQUIRED');

    const c = makeClient();
    await c.post('/api/auth/register', {
      email: 'lifecycle@example.test',
      password: 'correct-horse-battery',
      name: 'Life',
    });

    const authed = await c.get('/api/auth/me');
    assert.equal(authed.status, 200);
    assert.equal(authed.body.data.user.email, 'lifecycle@example.test');

    const loggedOut = await c.post('/api/auth/logout');
    assert.equal(loggedOut.status, 204);
    // The jar drops both cookies only if clearCookie used matching
    // attributes. A mismatch here is the "logout says success but you are
    // still logged in" bug.
    assert.ok(!c.cookies.has('aika_session'), 'session cookie cleared');
    assert.ok(!c.cookies.has('aika_csrf'), 'csrf cookie cleared');

    const after = await c.get('/api/auth/me');
    assert.equal(after.status, 401);
  });

  test('a tampered session token is rejected as AUTH_INVALID', async () => {
    const c = makeClient();
    await c.post('/api/auth/register', {
      email: 'tamper@example.test',
      password: 'correct-horse-battery',
      name: 'T',
    });

    const good = c.cookies.get('aika_session');
    c.cookies.set('aika_session', `${good.slice(0, -3)}xyz`); // break the signature

    const res = await c.get('/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'AUTH_INVALID');
  });
});

describe('csrf', () => {
  test('a state-changing request without the header is 403, with it is 204', async () => {
    const c = makeClient();
    await c.post('/api/auth/register', {
      email: 'csrf@example.test',
      password: 'correct-horse-battery',
      name: 'C',
    });

    // Cookies still sent — exactly what a cross-site form would achieve —
    // but no X-CSRF-Token header, which it cannot produce.
    const forged = await c.post('/api/auth/logout', undefined, { withCsrf: false });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error.code, 'CSRF_INVALID');

    const legitimate = await c.post('/api/auth/logout');
    assert.equal(legitimate.status, 204);
  });

  test('a header that does not match the cookie is rejected', async () => {
    const c = makeClient();
    await c.post('/api/auth/register', {
      email: 'csrf2@example.test',
      password: 'correct-horse-battery',
      name: 'C2',
    });

    const res = await c.post('/api/auth/logout', undefined, {
      headers: { 'x-csrf-token': 'guessed-value' },
    });
    assert.equal(res.status, 403);
  });

  test('GET requests need no csrf token', async () => {
    const c = makeClient();
    await c.post('/api/auth/register', {
      email: 'csrf3@example.test',
      password: 'correct-horse-battery',
      name: 'C3',
    });
    const res = await c.get('/api/auth/me', { withCsrf: false });
    assert.equal(res.status, 200);
  });
});

// ===========================================================================
// The test this phase exists for.
// ===========================================================================
describe('cross-tenant isolation', () => {
  let victimKbId;
  let attacker;

  before(async () => {
    const victim = await User.create({
      email: 'victim@example.test',
      name: 'Victim',
      passwordHash: await hashPassword('victim-password-123'),
    });
    const kb = await KnowledgeBase.create({
      userId: victim._id,
      name: 'Victim Private KB',
      description: 'Must never be readable by another account.',
    });
    victimKbId = kb._id.toString();

    attacker = makeClient();
    await attacker.post('/api/auth/register', {
      email: 'attacker@example.test',
      password: 'correct-horse-battery',
      name: 'Attacker',
    });
  });

  test('a REAL knowledge base owned by another user returns 404, not 403', async () => {
    const res = await attacker.get(`/api/knowledge-bases/${victimKbId}`);

    assert.equal(res.status, 404, 'must be 404 — 403 would confirm it exists');
    assert.equal(res.body.error.code, 'KB_NOT_FOUND');
    assert.equal(res.body.data, null);

    // Nothing about the resource may leak, not even its name.
    assert.ok(!JSON.stringify(res.body).includes('Victim'), 'no detail leaked');
  });

  test('a nonexistent id is INDISTINGUISHABLE from another user\'s', async () => {
    const nonexistent = new mongoose.Types.ObjectId().toString();

    const foreign = await attacker.get(`/api/knowledge-bases/${victimKbId}`);
    const missing = await attacker.get(`/api/knowledge-bases/${nonexistent}`);

    assert.equal(foreign.status, missing.status);
    assert.equal(foreign.body.error.code, missing.body.error.code);
    assert.equal(foreign.body.error.message, missing.body.error.message);
  });

  test('a malformed id also returns 404, not a 500 cast error', async () => {
    const res = await attacker.get('/api/knowledge-bases/not-an-object-id');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'KB_NOT_FOUND');
  });

  test('the list endpoint returns only the caller\'s own knowledge bases', async () => {
    const res = await attacker.get('/api/knowledge-bases');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 0, 'attacker owns none');
    assert.equal(res.body.data.pagination.total, 0);
  });

  test('the victim CAN read their own knowledge base', async () => {
    const victim = makeClient();
    await victim.post('/api/auth/login', {
      email: 'victim@example.test',
      password: 'victim-password-123',
    });

    const res = await victim.get(`/api/knowledge-bases/${victimKbId}`);
    // Without this the 404s above would pass even if the route were simply
    // broken for everyone.
    assert.equal(res.status, 200);
    assert.equal(res.body.data.knowledgeBase.name, 'Victim Private KB');
  });

  test('protected routes reject an anonymous caller', async () => {
    const res = await makeClient().get(`/api/knowledge-bases/${victimKbId}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'AUTH_REQUIRED');
  });
});
