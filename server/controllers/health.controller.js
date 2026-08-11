import { ok } from '../utils/respond.js';
import { config } from '../config/env.js';
import { pingDatabase } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const startedAt = Date.now();

/**
 * Liveness and per-dependency health.
 *
 * Each dependency reports separately, on purpose: a single boolean would mark
 * the whole API as down when only one subsystem is affected. Overall status is
 * `ok` when everything passes and `degraded` otherwise.
 *
 * The endpoint answers **200 even when degraded**. It is reporting
 * successfully -- the report is simply bad news. Returning 503 would make a
 * load balancer pull the instance out of rotation over a Mongo blip, taking
 * down browsing and login too. A caller that wants to alert reads
 * `data.status`, not the HTTP code.
 */
export const getHealth = asyncHandler(async (req, res) => {
  const mongo = await pingDatabase();

  const checks = {
    api: { status: 'ok' },
    mongo,
    // aiService: added in phase 10
  };

  const degraded = Object.values(checks).some((check) => check.status !== 'ok');

  return ok(res, {
    status: degraded ? 'degraded' : 'ok',
    environment: config.nodeEnv,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    requestId: req.id,
    checks,
  });
});
