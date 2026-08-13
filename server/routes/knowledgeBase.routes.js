import { Router } from 'express';
import {
  listKnowledgeBases,
  getKnowledgeBase,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
} from '../controllers/knowledgeBase.controller.js';
import { uploadDocument, listDocuments } from '../controllers/document.controller.js';
import { receiveUpload, verifyFileContent } from '../middleware/upload.js';
import { ask, listConversations } from '../controllers/chat.controller.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { config } from '../config/env.js';

// requireAuth and requireCsrfToken are applied once at the mount point in
// routes/index.js, so a route added here cannot accidentally be public.
const router = Router();

/*
 * The ask limiter, per minute rather than per fifteen. Each ask fans out to
 * retrieval plus a streamed LLM generation -- by far the most expensive thing
 * the API does, and the easiest to run up a bill or starve other users with.
 * A separate, per-minute tier keeps one authenticated caller from monopolising
 * the answering service. It is keyed by IP like the others; a per-user key is a
 * phase-14 refinement once quotas exist.
 */
const askLimiter = createRateLimiter({ ...config.rateLimits.ask, name: 'ask' });

router.get('/', listKnowledgeBases);
router.post('/', createKnowledgeBase);

router.get('/:id', getKnowledgeBase);
router.patch('/:id', updateKnowledgeBase);
router.delete('/:id', deleteKnowledgeBase);

// Documents are nested under their knowledge base for creation and listing,
// because both are meaningless without the parent — and nesting is what makes
// the parent-ownership check unavoidable.
router.get('/:id/documents', listDocuments);
router.post('/:id/documents', receiveUpload, verifyFileContent, uploadDocument);

router.get('/:id/conversations', listConversations);
router.post('/:id/ask', askLimiter, ask);

export default router;
