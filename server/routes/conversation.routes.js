import { Router } from 'express';
import { listMessages, deleteConversation } from '../controllers/chat.controller.js';

const router = Router();

router.get('/:id/messages', listMessages);
router.delete('/:id', deleteConversation);

export default router;
