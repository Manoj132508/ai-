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

// requireAuth and requireCsrfToken are applied once at the mount point in
// routes/index.js, so a route added here cannot accidentally be public.
const router = Router();

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
router.post('/:id/ask', ask);

export default router;
