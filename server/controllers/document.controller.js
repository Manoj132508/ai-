import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, okPaginated, noContent } from '../utils/respond.js';
import { findOwned } from '../utils/ownership.js';
import { deleteStoredFile } from '../services/fileStorage.js';
import { KnowledgeBase, Document, DOCUMENT_STATUSES } from '../models/index.js';

/**
 * Recomputes a knowledge base's denormalised counts from source.
 *
 * The counts are advisory (see the model), so this repairs drift rather than
 * incrementing and hoping. An `$inc` is cheaper but wrong the moment one
 * update fails: the count then stays wrong forever, because nothing ever
 * recalculates it. Recomputing costs one indexed count and one small
 * aggregation, which is nothing next to the upload it follows.
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
  // Ownership of the PARENT is checked before the child is created. Without
  // this, anyone could upload into another tenant's knowledge base by id.
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');

  const document = await Document.create({
    knowledgeBaseId: kb._id,
    userId: req.user.id,
    originalName: req.file.originalname,
    storedPath: req.file.filename,
    // The DETECTED type from content sniffing, never req.file.mimetype, which
    // is whatever the client claimed.
    mimeType: req.file.detectedMimeType,
    sizeBytes: req.file.size,
    status: 'uploaded',
  });

  await refreshCounts(kb._id);

  req.log.info('document uploaded', {
    documentId: String(document._id),
    knowledgeBaseId: String(kb._id),
    bytes: req.file.size,
    mimeType: req.file.detectedMimeType,
  });

  /*
   * 202, not 201.
   *
   * The row exists, but the work the user actually asked for -- making this
   * document answerable -- has not happened. 201 would say "created and
   * ready". The status field is the source of truth for progress, and the
   * client polls it (ADR 007).
   *
   * Phase 10 kicks off indexing here. Until then the document stays
   * 'uploaded' forever, which is honest: nothing is indexing it.
   */
  return ok(res, { document }, 202);
});

export const listDocuments = asyncHandler(async (req, res) => {
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

  const filter = { knowledgeBaseId: kb._id };
  // Silently ignoring an unknown status would show the full list and look
  // like the filter is broken, so only known values are honoured.
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

/**
 * Deletes a document: vectors, then file, then row (ADR 006).
 *
 * A failure after the vectors are gone leaves a row that returns nothing —
 * visible and retryable. The reverse leaves searchable content the user
 * believes they deleted.
 */
export const deleteDocument = asyncHandler(async (req, res) => {
  const document = await findOwned(Document, req.params.id, req.user.id, 'DOC_NOT_FOUND');

  // Phase 10: delete this document's vectors from Chroma FIRST.

  await deleteStoredFile(document.storedPath, { requestId: req.id });
  await Document.deleteOne({ _id: document._id });
  await refreshCounts(document.knowledgeBaseId);

  req.log.info('document deleted', { documentId: String(document._id) });
  return noContent(res);
});
