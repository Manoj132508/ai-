import { ok } from '../utils/respond.js';
import { config } from '../config/env.js';

const startedAt = Date.now();

/**
 * Liveness and dependency check.
 *
 * Phase 6 has no dependencies to check yet, so `checks` reports only the
 * process. Phase 7 adds MongoDB and Phase 10 the AI service, each as its own
 * entry with its own status -- deliberately, so a partial outage is visible
 * as a partial outage. A single boolean "healthy" would report the whole API
 * as down when only document indexing is affected.
 *
 * Overall status is `ok` when everything passes and `degraded` otherwise. The
 * endpoint still answers 200 while degraded: it is reporting successfully,
 * and a load balancer removing the instance for a Chroma blip would take down
 * login and browsing too.
 */
export function getHealth(req, res) {
  const checks = {
    api: { status: 'ok' },
    // mongo:     added in phase 7
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
}
