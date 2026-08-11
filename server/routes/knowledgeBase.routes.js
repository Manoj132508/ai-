import { Router } from 'express';
import {
  listKnowledgeBases,
  getKnowledgeBase,
} from '../controllers/knowledgeBase.controller.js';

const router = Router();

// requireAuth is applied once where this router is mounted, so a new route
// added here cannot accidentally be public.
router.get('/', listKnowledgeBases);
router.get('/:id', getKnowledgeBase);

export default router;
