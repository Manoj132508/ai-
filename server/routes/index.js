import { Router } from 'express';
import { config } from '../config/env.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireCsrfToken } from '../middleware/csrf.js';

import healthRoutes from './health.routes.js';
import devRoutes from './dev.routes.js';
import authRoutes from './auth.routes.js';
import knowledgeBaseRoutes from './knowledgeBase.routes.js';

const router = Router();

// --- public ------------------------------------------------------------
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);

// --- authenticated -----------------------------------------------------
/*
 * requireAuth and requireCsrfToken are applied HERE, at the mount point,
 * rather than on each route inside the sub-routers.
 *
 * A protected route added to knowledgeBase.routes.js is protected the moment
 * it exists, with no chance of someone forgetting the middleware — the same
 * "make it impossible rather than remembered" principle behind the ownership
 * helper and the <RequireAuth> layout route on the client.
 *
 * requireCsrfToken is a no-op on GET/HEAD/OPTIONS, so mounting it broadly
 * costs nothing on reads.
 */
router.use('/knowledge-bases', requireAuth, requireCsrfToken, knowledgeBaseRoutes);

// --- development only ---------------------------------------------------
if (!config.isProduction) {
  router.use('/dev', devRoutes);
}

// Phase 9+: /documents, /conversations

export default router;
