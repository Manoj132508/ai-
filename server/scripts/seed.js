/**
 * Idempotent development seed.
 *
 *   npm run seed            upsert the fixture; safe to run any number of times
 *   npm run seed -- --reset delete the seeded data first, then insert
 *
 * IDEMPOTENCY STRATEGY
 *
 * Every document is upserted on a *natural key* -- a value that identifies the
 * fixture regardless of what _id it was given on a previous run:
 *
 *   User          email
 *   KnowledgeBase (userId, name)          -- already uniquely indexed
 *   Document      (knowledgeBaseId, originalName)
 *   Conversation  (knowledgeBaseId, title)
 *   Message       (conversationId, role, content)
 *
 * Inserted fields go in `$setOnInsert`, so re-running never overwrites edits
 * made while developing. A seed that resets your data every time you restart
 * the server is a seed people stop running.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { hashPassword } from '../utils/password.js';
import {
  User,
  KnowledgeBase,
  Document,
  Conversation,
  Message,
} from '../models/index.js';

const RESET = process.argv.includes('--reset');

// .test is reserved by RFC 2606, so these can never collide with a real domain.
const SEED_EMAIL = 'demo@example.test';
const SEED_PASSWORD = 'demo-password-123';

/*
 * A SECOND user, owning nothing the first can see.
 *
 * This exists so cross-tenant isolation can be tested against real data
 * rather than a fabricated ObjectId. A test that asks for a *nonexistent* id
 * gets a 404 whether or not tenancy works; only a request for a real resource
 * belonging to someone else proves anything.
 */
const OTHER_EMAIL = 'other@example.test';
const OTHER_PASSWORD = 'other-password-123';

/**
 * @param insertOnly  written only when the document is created, so re-running
 *                    never clobbers edits made while developing
 * @param always      written on every run — used for the password hash, so the
 *                    documented seed credentials always work even after the
 *                    hashing scheme changes between phases
 */
async function upsert(Model, naturalKey, insertOnly, always = {}) {
  const update = { $setOnInsert: { ...naturalKey, ...insertOnly } };
  if (Object.keys(always).length > 0) update.$set = always;

  return Model.findOneAndUpdate(naturalKey, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });
}

async function reset(userId) {
  // Scoped to the seeded user only -- a seed script must never be capable of
  // wiping data it did not create.
  const kbs = await KnowledgeBase.find({ userId }).select('_id');
  const kbIds = kbs.map((kb) => kb._id);
  const convos = await Conversation.find({ knowledgeBaseId: { $in: kbIds } }).select('_id');

  const results = await Promise.all([
    Message.deleteMany({ conversationId: { $in: convos.map((c) => c._id) } }),
    Conversation.deleteMany({ knowledgeBaseId: { $in: kbIds } }),
    Document.deleteMany({ knowledgeBaseId: { $in: kbIds } }),
    KnowledgeBase.deleteMany({ userId }),
  ]);

  console.log(
    `  reset: removed ${results.map((r) => r.deletedCount).join('/')} ` +
      `messages/conversations/documents/knowledge-bases`,
  );
}

async function seed() {
  await connectDatabase();

  const user = await upsert(
    User,
    { email: SEED_EMAIL },
    { name: 'Demo User' },
    { passwordHash: await hashPassword(SEED_PASSWORD) },
  );

  const other = await upsert(
    User,
    { email: OTHER_EMAIL },
    { name: 'Other User' },
    { passwordHash: await hashPassword(OTHER_PASSWORD) },
  );

  if (RESET) {
    await reset(user._id);
    await reset(other._id);
  }

  // The other tenant's data. The demo user must never be able to read this,
  // and the cross-tenant test asserts exactly that.
  await upsert(
    KnowledgeBase,
    { userId: other._id, name: 'Other Tenant Private KB' },
    { description: 'Belongs to other@example.test. Demo user must get a 404.' },
  );

  // --- knowledge bases ------------------------------------------------
  const hr = await upsert(
    KnowledgeBase,
    { userId: user._id, name: 'HR Policies' },
    { description: 'Employee handbook, leave policy and contracts.' },
  );

  const specs = await upsert(
    KnowledgeBase,
    { userId: user._id, name: 'Technical Specs' },
    { description: 'API specifications and architecture notes.' },
  );

  // Deliberately left with no documents, so the empty-state path from the
  // phase 4 state matrix is reachable without deleting anything.
  await upsert(
    KnowledgeBase,
    { userId: user._id, name: 'Empty Knowledge Base' },
    { description: 'Intentionally empty, to exercise the empty state.' },
  );

  // --- documents ------------------------------------------------------
  // One per status, so every StatusBadge variant and the failed-row error
  // path can be seen without waiting for a real failure.
  const documents = [
    {
      knowledgeBaseId: hr._id,
      originalName: 'employee-handbook.pdf',
      status: 'indexed',
      pageCount: 24,
      chunkCount: 87,
      sizeBytes: 2_411_008,
      indexedAt: new Date(),
    },
    {
      knowledgeBaseId: hr._id,
      originalName: 'leave-policy.pdf',
      status: 'indexed',
      pageCount: 6,
      chunkCount: 19,
      sizeBytes: 512_000,
      indexedAt: new Date(),
    },
    {
      knowledgeBaseId: hr._id,
      originalName: 'contract-template.pdf',
      status: 'processing',
      sizeBytes: 1_150_976,
      processingStartedAt: new Date(),
    },
    {
      knowledgeBaseId: hr._id,
      originalName: 'scanned-appendix.pdf',
      status: 'failed',
      sizeBytes: 8_388_608,
      errorMessage:
        'No readable text could be extracted. This file may be a scanned image rather than a text PDF.',
    },
    {
      knowledgeBaseId: specs._id,
      originalName: 'api-specification.md',
      status: 'indexed',
      pageCount: 12,
      chunkCount: 41,
      sizeBytes: 84_992,
      indexedAt: new Date(),
    },
  ];

  const savedDocs = [];
  for (const doc of documents) {
    savedDocs.push(
      await upsert(
        Document,
        { knowledgeBaseId: doc.knowledgeBaseId, originalName: doc.originalName },
        {
          userId: user._id,
          storedPath: `uploads/seed-${doc.originalName}`,
          mimeType: doc.originalName.endsWith('.md') ? 'text/markdown' : 'application/pdf',
          ...doc,
        },
      ),
    );
  }

  // --- conversation with citations -------------------------------------
  const conversation = await upsert(
    Conversation,
    { knowledgeBaseId: hr._id, title: 'How much notice do I need to give?' },
    { userId: user._id, lastMessageAt: new Date() },
  );

  const handbook = savedDocs.find((d) => d.originalName === 'employee-handbook.pdf');

  const messages = [
    {
      role: 'user',
      content: 'How much notice do I need to give?',
      status: 'complete',
    },
    {
      role: 'assistant',
      content:
        'You must give 30 days’ written notice. [1] Employees still in their ' +
        'probationary period give 7 days instead. [2]',
      status: 'complete',
      latencyMs: 2840,
      retrievalMeta: { topScore: 0.78, retrievedCount: 5, grounded: true },
      citations: [
        {
          documentId: handbook._id,
          documentName: 'employee-handbook.pdf',
          page: 12,
          score: 0.78,
          snippet:
            'Termination by the employee requires 30 days’ written notification to their line manager.',
        },
        {
          documentId: handbook._id,
          documentName: 'employee-handbook.pdf',
          page: 14,
          score: 0.71,
          snippet:
            'During the probationary period, either party may terminate with 7 days’ notice.',
        },
      ],
    },
    {
      role: 'user',
      content: 'What is the capital of France?',
      status: 'complete',
    },
    {
      // The grounded-refusal path (ADR 008). Seeded so the UI for "not in your
      // documents" is developed against real data rather than imagined.
      role: 'assistant',
      content: 'I couldn’t find this in your documents.',
      status: 'complete',
      latencyMs: 240,
      retrievalMeta: { topScore: 0.11, retrievedCount: 5, grounded: false },
      citations: [],
    },
  ];

  for (const message of messages) {
    await upsert(
      Message,
      { conversationId: conversation._id, role: message.role, content: message.content },
      { userId: user._id, ...message },
    );
  }

  // --- recompute denormalised counts ------------------------------------
  // The counts on KnowledgeBase are advisory (see the model). Recomputing
  // them from the source collections is exactly how a drifted count is
  // repaired in production, so the seed uses the same path rather than
  // hard-coding numbers that would themselves go stale.
  for (const kb of [hr, specs]) {
    const [documentCount, agg] = await Promise.all([
      Document.countDocuments({ knowledgeBaseId: kb._id }),
      Document.aggregate([
        { $match: { knowledgeBaseId: kb._id } },
        { $group: { _id: null, total: { $sum: '$chunkCount' } } },
      ]),
    ]);
    await KnowledgeBase.updateOne(
      { _id: kb._id },
      { documentCount, chunkCount: agg[0]?.total ?? 0 },
    );
  }

  await Conversation.updateOne(
    { _id: conversation._id },
    { messageCount: await Message.countDocuments({ conversationId: conversation._id }) },
  );

  // --- summary -----------------------------------------------------------
  const counts = {
    users: await User.countDocuments(),
    knowledgeBases: await KnowledgeBase.countDocuments({ userId: user._id }),
    documents: await Document.countDocuments({ userId: user._id }),
    conversations: await Conversation.countDocuments({ userId: user._id }),
    messages: await Message.countDocuments({ userId: user._id }),
  };

  console.log(`\nSeeded database "${mongoose.connection.name}"`);
  console.log(`  demo user:  ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  console.log(`  other user: ${OTHER_EMAIL} / ${OTHER_PASSWORD}  (owns a private KB)`);
  for (const [key, value] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(16)} ${value}`);
  }

  await disconnectDatabase();
}

seed().catch(async (err) => {
  console.error('\nSeed failed:', err.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
