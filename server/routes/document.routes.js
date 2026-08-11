import { Router } from 'express';
import { getDocument, deleteDocument } from '../controllers/document.controller.js';

/*
 * Documents are addressed at the top level once they exist, not nested under
 * their knowledge base.
 *
 * /documents/:id needs no parent id: the document's own ownership check is
 * sufficient, and requiring the caller to know the knowledge base too would
 * be a second identifier that adds nothing. Creation stays nested because
 * there the parent genuinely is part of the address.
 */
const router = Router();

router.get('/:id', getDocument);
router.delete('/:id', deleteDocument);

export default router;
