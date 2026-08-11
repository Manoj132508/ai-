import { Router } from 'express';
import { config } from '../config/env.js';
import healthRoutes from './health.routes.js';
import devRoutes from './dev.routes.js';

/**
 * Single mount point for the API surface. app.js mounts this at /api and
 * knows nothing about individual resources, so adding one touches this file
 * only.
 */
const router = Router();

router.use('/health', healthRoutes);

// Deliberate-failure routes exist only outside production. This is a guard at
// mount time, not a check inside each handler: the routes are simply absent,
// so there is no reachable code path to reason about on a deployed server.
if (!config.isProduction) {
  router.use('/dev', devRoutes);
}

// Phase 7+: /auth, /knowledge-bases, /documents, /conversations

export default router;
