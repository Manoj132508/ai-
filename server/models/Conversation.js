import mongoose from 'mongoose';
import { baseSchemaOptions } from './schemaOptions.js';

const conversationSchema = new mongoose.Schema(
  {
    knowledgeBaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeBase',
      required: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Derived from the first question rather than asked for. Nobody titles a
    // conversation before having it.
    title: { type: String, required: true, trim: true, maxlength: 80 },

    messageCount: { type: Number, default: 0, min: 0 },

    /*
     * Separate from `updatedAt`, deliberately.
     *
     * `updatedAt` moves on *any* write -- a rename, a count correction. The
     * sidebar wants "most recently talked to", which is a different fact.
     * Sorting a chat list by updatedAt is how renaming an old conversation
     * jumps it to the top for no reason the user can see.
     */
    lastMessageAt: { type: Date, default: Date.now },
  },
  baseSchemaOptions(),
);

// The sidebar query: conversations for one knowledge base, most recent first.
conversationSchema.index({ knowledgeBaseId: 1, lastMessageAt: -1 });

// Tenancy check.
conversationSchema.index({ userId: 1, _id: 1 });

export const Conversation = mongoose.model('Conversation', conversationSchema);
