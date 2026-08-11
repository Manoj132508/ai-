import { ApiError } from '../utils/ApiError.js';

/**
 * Terminal 404 for any request that matched no route.
 *
 * Mounted after every route and before the error handler. Rather than sending
 * a response directly, it throws into the error pipeline, so an unmatched
 * route produces exactly the same envelope, the same logging and the same
 * request-id header as every other failure. Two code paths that both produce
 * "not found" would eventually drift apart.
 */
export function notFound(req, _res, next) {
  next(new ApiError('ROUTE_NOT_FOUND', `Cannot ${req.method} ${req.originalUrl}`));
}
