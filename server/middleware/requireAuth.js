import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifySessionToken } from '../utils/jwt.js';
import { SESSION_COOKIE } from '../utils/cookies.js';
import { User } from '../models/index.js';

/**
 * Rejects anything without a valid session, and attaches `req.user`.
 *
 * THIS IS THE SECURITY BOUNDARY. The frontend's <RequireAuth> decides what to
 * render; it protects navigation, not data. Anyone can call this API directly
 * with curl, so every protected route passes through here regardless of what
 * the SPA does.
 *
 * Two distinct codes, both 401:
 *   AUTH_REQUIRED — no cookie at all. The client should send the user to log in.
 *   AUTH_INVALID  — a cookie that does not verify. The client should clear
 *                   local state and send the user to log in.
 * The distinction is for the client's behaviour, not the user's information:
 * neither message says *why* a token failed.
 */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) throw new ApiError('AUTH_REQUIRED');

  const payload = verifySessionToken(token);
  if (!payload?.sub) throw new ApiError('AUTH_INVALID');

  /*
   * The database lookup is not redundant.
   *
   * A signature proves the token was minted by us and has not expired. It says
   * nothing about whether the account still exists. Without this, a deleted
   * user keeps full access until their token expires, and every downstream
   * query runs against a userId with no owner.
   *
   * The cost is one indexed find per request. Skipping it is a real
   * optimisation for a high-traffic API — and a real trade, not a free one.
   */
  const user = await User.findById(payload.sub);
  if (!user) throw new ApiError('AUTH_INVALID');

  // Only what routes need. Deliberately not the mongoose document, so no
  // handler can accidentally serialise a model or call .save() on it.
  req.user = { id: user._id, email: user.email, name: user.name };
  req.log = req.log.child ? req.log : req.log; // keep bound logger

  next();
});
