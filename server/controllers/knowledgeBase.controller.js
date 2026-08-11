import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, okPaginated } from '../utils/respond.js';
import { findOwned } from '../utils/ownership.js';
import { KnowledgeBase } from '../models/index.js';

/**
 * Read-only knowledge base endpoints.
 *
 * Phase 8 needs a real tenant-owned resource to prove the ownership rule
 * against; create, update and delete arrive in phase 9. What matters here is
 * that BOTH handlers scope by userId in the query itself.
 */

export const listKnowledgeBases = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));

  // userId is in the filter, not applied afterwards. This is the same index
  // the phase 7 explain() confirmed: { userId: 1, createdAt: -1 }, equality
  // then sort, so no in-memory sort.
  const filter = { userId: req.user.id };

  const [items, total] = await Promise.all([
    KnowledgeBase.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    KnowledgeBase.countDocuments(filter),
  ]);

  return okPaginated(res, items, { page, limit, total });
});

export const getKnowledgeBase = asyncHandler(async (req, res) => {
  // Throws KB_NOT_FOUND (404) for a missing id AND for another user's id.
  // The caller cannot tell which, by design.
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');
  return ok(res, { knowledgeBase: kb });
});
