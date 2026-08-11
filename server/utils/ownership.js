import mongoose from 'mongoose';
import { ApiError } from './ApiError.js';

/**
 * Loads a tenant-owned document, or throws 404.
 *
 * THE INVARIANT THIS ENFORCES
 *
 *   Never:   const kb = await KnowledgeBase.findById(id);
 *            if (!kb.userId.equals(req.user.id)) throw ...
 *
 *   Always:  await findOwned(KnowledgeBase, id, req.user.id, 'KB_NOT_FOUND')
 *
 * The first form works and is one forgotten line away from leaking every
 * tenant's data. The second cannot fetch another user's row at all, because
 * ownership is part of the query rather than a check applied afterwards.
 *
 * WHY 404 AND NOT 403
 *
 * A 403 confirms the resource exists. Walk a range of ids, note which return
 * 403 and which 404, and you have enumerated other tenants' resources without
 * ever reading one — that is the IDOR pattern. Returning 404 for both
 * "no such id" and "not yours" makes those cases indistinguishable.
 *
 * It also closes the timing channel: because ownership is in the query, both
 * cases take one indexed lookup that returns nothing. A fetch-then-compare
 * would be measurably slower for a real-but-foreign id.
 */
export async function findOwned(Model, id, userId, notFoundCode) {
  // An id that is not a valid ObjectId would make Mongoose throw a CastError,
  // which would surface as a 500 — telling a caller that their input was
  // *malformed* rather than simply absent. Same outcome for both.
  if (!mongoose.isValidObjectId(id)) throw new ApiError(notFoundCode);

  const doc = await Model.findOne({ _id: id, userId });
  if (!doc) throw new ApiError(notFoundCode);

  return doc;
}
