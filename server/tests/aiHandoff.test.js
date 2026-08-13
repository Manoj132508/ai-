/**
 * The upload -> index handoff.
 *
 *   npm test
 *
 * This is the seam the rest of the upload suite deliberately skips: the
 * fire-and-forget call to the AI service. It is covered here by INJECTING a
 * fake client (setAiClient) instead of hitting a real Python process, then
 * waiting for the background chain to move the document out of 'processing'.
 * No network, no Python, deterministic.
 */
import test, { before, after, afterEach, describe } from 'node:test';
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
process.env.UPLOAD_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'aika-handoff-'));

const { createApp } = await import('../app.js');
const { connectDatabase, disconnectDatabase } = await import('../config/db.js');
const mongoose = (await import('mongoose')).default;
await import('../models/index.js');
const { KnowledgeBase, Document } = await import('../models/index.js');
const { setAiClient, resetAiClient } = await import('../services/aiClient.js');

const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'ascii');

let server;
let baseUrl;
let client;

function makeClient() {
  const jar = new Map();
  return {
    jar,
    async request(method, p, { body, form } = {}) {
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const token = jar.get('aika_csrf');
      const res = await fetch(`${baseUrl}${p}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          ...(token ? { 'x-csrf-token': token } : {}),
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
      const textBody = await res.text();
      return { status: res.status, body: textBody ? JSON.parse(textBody) : null };
    },
    post(p, b) { return this.request('POST', p, { body: b }); },
    upload(p, filename, bytes, contentType) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: contentType }), filename);
      return this.request('POST', p, { form });
    },
  };
}

/** Polls until `predicate` is true or the timeout elapses -- the background
 *  chain is fire-and-forget, so there is no promise to await from the outside. */
async function waitFor(predicate, { timeout = 2000, interval = 15 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the background handoff');
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function uploadPdf(kbId, name = 'doc.pdf') {
  const res = await client.upload(`/api/knowledge-bases/${kbId}/documents`, name, PDF_BYTES, 'application/pdf');
  assert.equal(res.status, 202);
  assert.equal(res.body.data.document.status, 'processing', 'starts processing before the handoff');
  return res.body.data.document.id;
}

before(async () => {
  await connectDatabase();
  await mongoose.connection.dropDatabase();
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  client = makeClient();
  await client.post('/api/auth/register', {
    email: 'handoff@example.test',
    password: 'correct-horse-battery',
    name: 'Handoff',
  });
});

afterEach(() => {
  // Restore the default (no client) so one test's fake never leaks into another.
  resetAiClient();
});

after(async () => {
  await new Promise((r) => server.close(r));
  await disconnectDatabase();
  await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
});

describe('upload -> index handoff', () => {
  test('a successful index moves the document to "indexed" with the chunk count', async () => {
    const calls = [];
    setAiClient({
      indexDocument: async (args) => {
        calls.push(args);
        return { chunk_count: 7 };
      },
    });

    const kb = await client.post('/api/knowledge-bases', { name: 'HandoffOK' });
    const kbId = kb.body.data.knowledgeBase.id;
    const docId = await uploadPdf(kbId);

    await waitFor(async () => (await Document.findById(docId))?.status === 'indexed');

    const doc = await Document.findById(docId);
    assert.equal(doc.status, 'indexed');
    assert.equal(doc.chunkCount, 7, 'chunk_count from the AI service is persisted');

    // The handoff was actually invoked, with a resolved absolute path and the
    // ids the Python service needs.
    assert.equal(calls.length, 1);
    assert.equal(String(calls[0].documentId), docId);
    assert.equal(String(calls[0].knowledgeBaseId), kbId);
    assert.ok(path.isAbsolute(calls[0].filePath), 'the stored path is resolved to absolute');
    assert.equal(calls[0].mimeType, 'application/pdf');

    // The denormalised KB counter is refreshed from source afterwards.
    const refreshed = await KnowledgeBase.findById(kbId);
    assert.equal(refreshed.chunkCount, 7);
  });

  test('an indexing failure moves the document to "failed" with a user-safe message', async () => {
    setAiClient({
      // The raw error carries a status and internal text, exactly what must NOT
      // reach the user.
      indexDocument: async () => {
        throw new Error('AI Microservice error (500): http://10.0.0.4:8000 traceback ...');
      },
    });

    const kb = await client.post('/api/knowledge-bases', { name: 'HandoffFail' });
    const docId = await uploadPdf(kb.body.data.knowledgeBase.id, 'broken.pdf');

    await waitFor(async () => (await Document.findById(docId))?.status === 'failed');

    const doc = await Document.findById(docId);
    assert.equal(doc.errorMessage, 'Indexing failed. You can retry this document.');
    assert.ok(!/10\.0\.0\.4|traceback|500/.test(doc.errorMessage), 'no internals leak to the user');
  });

  test('a 422 (no readable text) maps to the scanned-image message', async () => {
    setAiClient({
      indexDocument: async () => {
        throw new Error('AI Microservice error (422): no extractable text');
      },
    });

    const kb = await client.post('/api/knowledge-bases', { name: 'Handoff422' });
    const docId = await uploadPdf(kb.body.data.knowledgeBase.id, 'scanned.pdf');

    await waitFor(async () => (await Document.findById(docId))?.status === 'failed');

    const doc = await Document.findById(docId);
    assert.match(doc.errorMessage, /scanned image/i);
  });

  test('with no injected client the upload stays "processing" and makes no call', async () => {
    // The default under test. This is what the rest of the upload suite relies
    // on -- proven here so the injection seam cannot silently change it.
    resetAiClient();

    const kb = await client.post('/api/knowledge-bases', { name: 'HandoffNone' });
    const docId = await uploadPdf(kb.body.data.knowledgeBase.id, 'untouched.pdf');

    // Give any (incorrectly wired) background work a chance to run, then assert
    // nothing moved it.
    await new Promise((r) => setTimeout(r, 100));
    const doc = await Document.findById(docId);
    assert.equal(doc.status, 'processing');
  });
});
