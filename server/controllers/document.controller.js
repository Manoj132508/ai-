import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, okPaginated, noContent } from '../utils/respond.js';
import { findOwned } from '../utils/ownership.js';
import { deleteStoredFile, resolveStoredPath } from '../services/fileStorage.js';
import { aiClient } from '../services/aiClient.js';
import { config } from '../config/env.js';
import { KnowledgeBase, Document, DOCUMENT_STATUSES } from '../models/index.js';

/**
 * Recomputes a knowledge base's denormalised counts from source.
 */
async function refreshCounts(knowledgeBaseId) {
  const [documentCount, chunks] = await Promise.all([
    Document.countDocuments({ knowledgeBaseId }),
    Document.aggregate([
      { $match: { knowledgeBaseId } },
      { $group: { _id: null, total: { $sum: '$chunkCount' } } },
    ]),
  ]);

  await KnowledgeBase.updateOne(
    { _id: knowledgeBaseId },
    { documentCount, chunkCount: chunks[0]?.total ?? 0 },
  );
}

export const uploadDocument = asyncHandler(async (req, res) => {
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');

  const document = await Document.create({
    knowledgeBaseId: kb._id,
    userId: req.user.id,
    originalName: req.file.originalname,
    storedPath: req.file.filename,
    mimeType: req.file.detectedMimeType,
    sizeBytes: req.file.size,

    /*
     * 'processing' immediately, not 'uploaded'.
     *
     * Indexing is fired below before this handler returns, so 'uploaded'
     * would be false the moment it was written. It also breaks two things
     * that key off this field: the client polls only while something is
     * 'processing' (so the status would never visibly update), and the ADR
     * 007 reaper finds stuck documents by 'processing' plus a stale
     * processingStartedAt (so a crash mid-index would leave a document
     * nothing ever reclaims).
     */
    status: 'processing',
    processingStartedAt: new Date(),
  });

  await refreshCounts(kb._id);

  req.log.info('document uploaded', {
    documentId: String(document._id),
    knowledgeBaseId: String(kb._id),
    bytes: req.file.size,
    mimeType: req.file.detectedMimeType,
  });

  /*
   * Fire-and-forget indexing (ADR 007).
   *
   * Skipped under NODE_ENV=test. Without the guard every upload test would
   * make a real HTTP call to the AI service, so the suite would pass or fail
   * depending on whether a separate Python process happens to be running --
   * and the background write would land at an unpredictable moment, racing
   * later assertions in the same file.
   *
   * The cost is honest and worth stating: the Node tests therefore do NOT
   * cover the handoff itself. Phase 12 makes aiClient injectable so it can be
   * faked rather than skipped, which is the real fix.
   */
  if (config.isTest) {
    return ok(res, { document }, 202);
  }

  const absolutePath = resolveStoredPath(document.storedPath);
  aiClient
    .indexDocument({
      documentId: document._id,
      knowledgeBaseId: kb._id,
      filePath: absolutePath,
      filename: document.originalName,
      mimeType: document.mimeType,
    })
    .then(async (result) => {
      await Document.updateOne(
        { _id: document._id },
        { status: 'indexed', chunkCount: result.chunk_count ?? 0 },
      );
      await refreshCounts(kb._id);
      req.log.info('document indexed in background', { documentId: String(document._id) });
    })
    .catch(async (err) => {
      /*
       * errorMessage is USER-FACING -- it renders inline under the failed row.
       * err.message here is the AI service's raw text, which carries status
       * codes, internal URLs and stack fragments. Same rule as the Express
       * error handler: the operator gets the detail in the log, the user gets
       * something they can act on.
       */
      const isUnreadable = /422/.test(err.message);
      const errorMessage = isUnreadable
        ? 'No readable text could be extracted. This file may be a scanned image rather than a text PDF.'
        : 'Indexing failed. You can retry this document.';

      await Document.updateOne({ _id: document._id }, { status: 'failed', errorMessage });

      req.log.error('background indexing failed', {
        documentId: String(document._id),
        detail: err.message,
      });
    });

  return ok(res, { document }, 202);
});

export const listDocuments = asyncHandler(async (req, res) => {
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const filter = { knowledgeBaseId: kb._id };
  if (DOCUMENT_STATUSES.includes(req.query.status)) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    Document.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Document.countDocuments(filter),
  ]);

  return okPaginated(res, items, { page, limit, total });
});

export const getDocument = asyncHandler(async (req, res) => {
  const document = await findOwned(Document, req.params.id, req.user.id, 'DOC_NOT_FOUND');
  return ok(res, { document });
});

export const deleteDocument = asyncHandler(async (req, res) => {
  const document = await findOwned(Document, req.params.id, req.user.id, 'DOC_NOT_FOUND');

  // Deletes vectors from ChromaDB FIRST (ADR 006)
  try {
    await aiClient.deleteDocumentVectors({
      knowledgeBaseId: document.knowledgeBaseId,
      documentId: document._id,
    });
  } catch (err) {
    req.log.warn('failed to delete document vectors from vector store', {
      documentId: String(document._id),
      error: err.message,
    });
  }

  await deleteStoredFile(document.storedPath, { requestId: req.id });
  await Document.deleteOne({ _id: document._id });
  await refreshCounts(document.knowledgeBaseId);

  req.log.info('document deleted', { documentId: String(document._id) });
  return noContent(res);
});

