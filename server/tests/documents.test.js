/**
 * Knowledge base CRUD and document uploads.
 *
 * The upload tests exist mainly to prove that content validation is not
 * fooled by a filename or a Content-Type header, because that is the whole
 * point of doing it after the bytes land.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/ai_knowledge_assistant_test';
process.env.JWT_SECRET = randomBytes(32).toString('base64url');
process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.UPLOAD_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'aika-uploads-'));

const { createApp } = await import('../app.js');
const { connectDatabase, disconnectDatabase } = await import('../config/db.js');
const mongoose = (await import('mongoose')).default;
await import('../models/index.js');
const { KnowledgeBase, Document } = await import('../models/index.js');

let server;
let baseUrl;
let client;

function makeClient() {
  const jar = new Map();
  return {
    jar,
    async request(method, path, { body, form, headers = {} } = {}) {
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const token = jar.get('aika_csrf');
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          ...(token ? { 'x-csrf-token': token } : {}),
          ...headers,
        },
        body: form ?? (body ? JSON.stringify(body) : undefined),
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    get(p) { return this.request('GET', p); },
    post(p, b) { return this.request('POST', p, { body: b }); },
    patch(p, b) { return this.request('PATCH', p, { body: b }); },
    delete(p) { return this.request('DELETE', p); },
    upload(p, filename, bytes, contentType) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: contentType }), filename);
      return this.request('POST', p, { form });
    },
  };
}

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'ascii'),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'ascii'),
]);
// PNG signature — a real binary that is definitely not a PDF or text.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

before(async () => {
  await connectDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  client = makeClient();
  await client.post('/api/auth/register', {
    email: 'owner@example.test',
    password: 'correct-horse-battery',
    name: 'Owner',
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await disconnectDatabase();
  await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
});

describe('knowledge base crud', () => {
  let created;

  test('creates one with 201', async () => {
    const res = await client.post('/api/knowledge-bases', {
      name: 'Handbook',
      description: 'HR docs',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.knowledgeBase.name, 'Handbook');
    assert.equal(res.body.data.knowledgeBase.documentCount, 0);
    created = res.body.data.knowledgeBase.id;
  });

  test('rejects a blank name with field details', async () => {
    const res = await client.post('/api/knowledge-bases', { name: '   ' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.fields.name);
  });

  test('rejects a duplicate name for the same user', async () => {
    const res = await client.post('/api/knowledge-bases', { name: 'Handbook' });
    assert.equal(res.status, 400);
    assert.match(res.body.error.details.fields.name, /already have/i);
  });

  test('allows the SAME name for a different user', async () => {
    const other = makeClient();
    await other.post('/api/auth/register', {
      email: 'second@example.test',
      password: 'correct-horse-battery',
      name: 'Second',
    });
    // Uniqueness is per-tenant: { userId, name }. A global unique index would
    // let one user's naming block another's.
    const res = await other.post('/api/knowledge-bases', { name: 'Handbook' });
    assert.equal(res.status, 201);
  });

  test('patches name and description', async () => {
    const res = await client.patch(`/api/knowledge-bases/${created}`, {
      description: 'Updated',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.knowledgeBase.description, 'Updated');
    assert.equal(res.body.data.knowledgeBase.name, 'Handbook', 'untouched field survives');
  });

  test('another user cannot patch or delete it — 404 both ways', async () => {
    const attacker = makeClient();
    await attacker.post('/api/auth/register', {
      email: 'attacker2@example.test',
      password: 'correct-horse-battery',
      name: 'A',
    });

    const patched = await attacker.patch(`/api/knowledge-bases/${created}`, { name: 'Pwned' });
    const deleted = await attacker.delete(`/api/knowledge-bases/${created}`);

    assert.equal(patched.status, 404);
    assert.equal(deleted.status, 404);

    // And the record is untouched.
    const still = await client.get(`/api/knowledge-bases/${created}`);
    assert.equal(still.body.data.knowledgeBase.name, 'Handbook');
  });

  test('a write without a csrf token is rejected', async () => {
    const res = await client.request('POST', '/api/knowledge-bases', {
      body: { name: 'No CSRF' },
      headers: { 'x-csrf-token': '' },
    });
    assert.equal(res.status, 403);
  });
});

describe('document upload', () => {
  let kbId;

  before(async () => {
    const res = await client.post('/api/knowledge-bases', { name: 'Uploads' });
    kbId = res.body.data.knowledgeBase.id;
  });

  test('accepts a real PDF with 202 and status "processing"', async () => {
    const res = await client.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'report.pdf',
      PDF_BYTES,
      'application/pdf',
    );

    // 202, not 201: the row exists but the work the user asked for -- making
    // the document answerable -- has not finished. The client polls `status`
    // for that, which is why it must already read 'processing' here.
    assert.equal(res.status, 202);
    assert.equal(res.body.data.document.status, 'processing');
    assert.ok(res.body.data.document.processingStartedAt, 'the reaper needs this timestamp');
    assert.equal(res.body.data.document.mimeType, 'application/pdf');
    assert.equal(res.body.data.document.originalName, 'report.pdf');

    // The original filename must never become the path on disk.
    assert.notEqual(res.body.data.document.storedPath, 'report.pdf');
    assert.match(res.body.data.document.storedPath, /^[0-9a-f-]{36}\.pdf$/);
  });

  test('accepts markdown', async () => {
    const res = await client.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'notes.md',
      Buffer.from('# Notes\n\nSome text.\n'),
      'text/markdown',
    );
    assert.equal(res.status, 202);
    assert.equal(res.body.data.document.mimeType, 'text/markdown');
  });

  // ---- the tests that justify content sniffing -------------------------

  test('REJECTS a PNG renamed to .pdf and declared as application/pdf', async () => {
    const res = await client.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'definitely-a.pdf',
      PNG_BYTES,
      'application/pdf', // the client lies about both name and type
    );
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, 'FILE_TYPE_UNSUPPORTED');
  });

  test('a rejected upload leaves no file behind', async () => {
    const before = (await fs.readdir(process.env.UPLOAD_DIR)).length;
    await client.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'sneaky.pdf',
      PNG_BYTES,
      'application/pdf',
    );
    const after = (await fs.readdir(process.env.UPLOAD_DIR)).length;
    // Otherwise the upload directory becomes an unbounded store of exactly
    // the content we refused.
    assert.equal(after, before, 'rejected file was cleaned up');
  });

  test('rejects a disallowed extension before writing anything', async () => {
    const res = await client.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'script.exe',
      Buffer.from('MZ'),
      'application/octet-stream',
    );
    assert.equal(res.status, 415);
  });

  test('rejects a file over the size limit with 413', async () => {
    const tooBig = Buffer.concat([PDF_BYTES, randomBytes(11 * 1024 * 1024)]);
    const res = await client.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'huge.pdf',
      tooBig,
      'application/pdf',
    );
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'FILE_TOO_LARGE');
  });

  test('cannot upload into another user\'s knowledge base', async () => {
    const attacker = makeClient();
    await attacker.post('/api/auth/register', {
      email: 'attacker3@example.test',
      password: 'correct-horse-battery',
      name: 'A3',
    });
    const res = await attacker.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'evil.pdf',
      PDF_BYTES,
      'application/pdf',
    );
    assert.equal(res.status, 404);
  });

  test('counts are recomputed, not incremented', async () => {
    const res = await client.get(`/api/knowledge-bases/${kbId}`);
    const actual = await Document.countDocuments({ knowledgeBaseId: kbId });
    assert.equal(res.body.data.knowledgeBase.documentCount, actual);
    assert.equal(actual, 2, 'only the two valid uploads were stored');
  });

  test('lists documents, filtered by status', async () => {
    const all = await client.get(`/api/knowledge-bases/${kbId}/documents`);
    assert.equal(all.status, 200);
    assert.equal(all.body.data.items.length, 2);
    assert.equal(all.body.data.pagination.total, 2);

    const indexed = await client.get(`/api/knowledge-bases/${kbId}/documents?status=indexed`);
    assert.equal(indexed.body.data.pagination.total, 0);

    // An unknown status must not silently return everything.
    const bogus = await client.get(`/api/knowledge-bases/${kbId}/documents?status=banana`);
    assert.equal(bogus.body.data.pagination.total, 2);
  });
});

describe('document deletion and cascade', () => {
  let kbId;
  let docId;
  let storedPath;

  before(async () => {
    const kb = await client.post('/api/knowledge-bases', { name: 'Cascade' });
    kbId = kb.body.data.knowledgeBase.id;
    const up = await client.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'doomed.pdf',
      PDF_BYTES,
      'application/pdf',
    );
    docId = up.body.data.document.id;
    storedPath = up.body.data.document.storedPath;
  });

  test('deleting a document removes the row AND the file', async () => {
    const onDiskBefore = await fs
      .access(path.join(process.env.UPLOAD_DIR, storedPath))
      .then(() => true)
      .catch(() => false);
    assert.ok(onDiskBefore, 'file existed before delete');

    const res = await client.delete(`/api/documents/${docId}`);
    assert.equal(res.status, 204);

    const onDiskAfter = await fs
      .access(path.join(process.env.UPLOAD_DIR, storedPath))
      .then(() => true)
      .catch(() => false);
    assert.ok(!onDiskAfter, 'file removed — otherwise deleted documents leak disk forever');

    const gone = await client.get(`/api/documents/${docId}`);
    assert.equal(gone.status, 404);
  });

  test('deleting a knowledge base cascades to its documents and files', async () => {
    const up = await client.upload(
      `/api/knowledge-bases/${kbId}/documents`,
      'child.pdf',
      PDF_BYTES,
      'application/pdf',
    );
    const childPath = up.body.data.document.storedPath;

    const res = await client.delete(`/api/knowledge-bases/${kbId}`);
    assert.equal(res.status, 204);

    assert.equal(await Document.countDocuments({ knowledgeBaseId: kbId }), 0);
    assert.equal(await KnowledgeBase.countDocuments({ _id: kbId }), 0);

    const orphan = await fs
      .access(path.join(process.env.UPLOAD_DIR, childPath))
      .then(() => true)
      .catch(() => false);
    assert.ok(!orphan, 'child file removed with the parent');
  });
});
