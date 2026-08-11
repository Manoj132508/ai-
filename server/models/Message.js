import mongoose from 'mongoose';
import { baseSchemaOptions } from './schemaOptions.js';

export const MESSAGE_ROLES = Object.freeze(['user', 'assistant']);
export const MESSAGE_STATUSES = Object.freeze(['complete', 'partial', 'failed']);

/*
 * Citations are EMBEDDED, not referenced.
 *
 * The three questions that decide embed-vs-reference in MongoDB:
 *
 *   Always read with the parent?  Yes -- an answer without its sources is
 *                                 useless, so they are never fetched apart.
 *   Immutable?                    Yes -- a citation records what *was*
 *                                 retrieved at that moment. Re-indexing the
 *                                 document later must not rewrite history.
 *   Bounded?                      Yes -- top-k, currently five.
 *
 * Three yeses means embed. Had they been unbounded, or independently
 * queryable ("which documents are cited most?"), referencing would win.
 *
 * documentName is denormalised in for the same reason it is denormalised into
 * the Chroma metadata: rendering five citations otherwise means five lookups
 * on the hot path of every answer. It may go stale if a document is renamed --
 * accepted, and noted.
 */
const citationSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', required: true },
    documentName: { type: String, required: true },
    page: { type: Number, default: null },
    score: { type: Number, required: true },
    snippet: { type: String, required: true, maxlength: 1000 },
  },
  { _id: false }, // sub-documents need no identity of their own
);

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    role: { type: String, enum: MESSAGE_ROLES, required: true },

    content: { type: String, required: true },

    /*
     * 'partial' exists because of the SSE cancellation path: the user closes
     * the tab after 300 tokens have streamed. Those tokens were generated and
     * billed, so discarding them loses real content -- and a returning user
     * would see a question with no answer at all. Persisting it as partial
     * means they see what there is, and abandonment becomes measurable
     * instead of invisible.
     */
    status: { type: String, enum: MESSAGE_STATUSES, default: 'complete' },

    citations: { type: [citationSchema], default: [] },

    // Kept so a wrongly-tuned retrieval threshold can be audited after the
    // fact. A threshold set too high refuses answerable questions *silently* --
    // the user sees a polite refusal, not an error, and nothing is logged as
    // wrong. topScore is the only evidence that would exist.
    retrievalMeta: {
      topScore: { type: Number, default: null },
      retrievedCount: { type: Number, default: null },
      grounded: { type: Boolean, default: null },
    },

    latencyMs: { type: Number, default: null },
  },
  baseSchemaOptions(),
);

// Messages in a conversation, oldest first -- transcripts read forwards.
// Ascending here, unlike every other sort index in this schema set.
messageSchema.index({ conversationId: 1, createdAt: 1 });

export const Message = mongoose.model('Message', messageSchema);
