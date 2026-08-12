import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { ok, okPaginated, noContent } from '../utils/respond.js';
import { findOwned } from '../utils/ownership.js';
import { deleteStoredFile } from '../services/fileStorage.js';
import { aiClient } from '../services/aiClient.js';
import { KnowledgeBase, Document, Conversation, Message } from '../models/index.js';

function validateBody({ name, description }, { partial = false } = {}) {
  const fields = {};

  const nameProvided = name !== undefined;
  if (!partial || nameProvided) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      fields.name = 'Name is required.';
    } else if (name.trim().length > 100) {
      fields.name = 'Name must be 100 characters or fewer.';
    }
  }

  if (description !== undefined) {
    if (typeof description !== 'string') fields.description = 'Description must be text.';
    else if (description.length > 500) {
      fields.description = 'Description must be 500 characters or fewer.';
    }
  }

  if (Object.keys(fields).length > 0) {
    throw new ApiError('VALIDATION_ERROR', 'Please correct the highlighted fields.', { fields });
  }
}

export const listKnowledgeBases = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));

  const filter = { userId: req.user.id };

  const [items, total] = await Promise.all([
    KnowledgeBase.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    KnowledgeBase.countDocuments(filter),
  ]);

  return okPaginated(res, items, { page, limit, total });
});

export const getKnowledgeBase = asyncHandler(async (req, res) => {
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');
  return ok(res, { knowledgeBase: kb });
});

export const createKnowledgeBase = asyncHandler(async (req, res) => {
  const { name, description } = req.body ?? {};
  validateBody({ name, description });

  try {
    const kb = await KnowledgeBase.create({
      userId: req.user.id,
      name: name.trim(),
      description: description?.trim() ?? '',
    });
    req.log.info('knowledge base created', { knowledgeBaseId: String(kb._id) });
    return ok(res, { knowledgeBase: kb }, 201);
  } catch (err) {
    if (err?.code === 11000) {
      throw new ApiError('VALIDATION_ERROR', 'Please correct the highlighted fields.', {
        fields: { name: 'You already have a knowledge base with that name.' },
      });
    }
    throw err;
  }
});

export const updateKnowledgeBase = asyncHandler(async (req, res) => {
  const { name, description } = req.body ?? {};
  validateBody({ name, description }, { partial: true });

  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');

  if (name !== undefined) kb.name = name.trim();
  if (description !== undefined) kb.description = description.trim();

  try {
    await kb.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw new ApiError('VALIDATION_ERROR', 'Please correct the highlighted fields.', {
        fields: { name: 'You already have a knowledge base with that name.' },
      });
    }
    throw err;
  }

  return ok(res, { knowledgeBase: kb });
});

export const deleteKnowledgeBase = asyncHandler(async (req, res) => {
  const kb = await findOwned(KnowledgeBase, req.params.id, req.user.id, 'KB_NOT_FOUND');

  // Drop Chroma vector collection FIRST (ADR 006)
  try {
    await aiClient.deleteCollection({ knowledgeBaseId: kb._id });
  } catch (err) {
    req.log.warn('failed to delete vector collection from Chroma', {
      knowledgeBaseId: String(kb._id),
      error: err.message,
    });
  }

  const documents = await Document.find({ knowledgeBaseId: kb._id }).select('storedPath');
  for (const doc of documents) {
    await deleteStoredFile(doc.storedPath, { requestId: req.id });
  }

  const conversations = await Conversation.find({ knowledgeBaseId: kb._id }).select('_id');
  await Message.deleteMany({ conversationId: { $in: conversations.map((c) => c._id) } });
  await Conversation.deleteMany({ knowledgeBaseId: kb._id });
  await Document.deleteMany({ knowledgeBaseId: kb._id });
  await KnowledgeBase.deleteOne({ _id: kb._id });

  req.log.info('knowledge base deleted', {
    knowledgeBaseId: String(kb._id),
    documents: documents.length,
  });

  return noContent(res);
});

