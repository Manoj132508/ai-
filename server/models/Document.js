import mongoose from 'mongoose';
import { baseSchemaOptions } from './schemaOptions.js';

/** Kept as a constant so the seed, the reaper and the UI badge share one list. */
export const DOCUMENT_STATUSES = Object.freeze([
  'uploaded',
  'processing',
  'indexed',
  'failed',
]);

const documentSchema = new mongoose.Schema(
  {
    knowledgeBaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeBase',
      required: true,
    },

    /*
     * userId is duplicated here even though it is reachable via the parent
     * knowledge base.
     *
     * Without it, checking ownership of a document means a join back through
     * KnowledgeBase. With it, every tenancy filter is a single-collection
     * query on an indexed field -- and the query-shaped enforcement from
     * phase 3 stays cheap.
     *
     * Denormalising a field that is immutable by design costs nothing: a
     * document can never change owner, so there is no update to keep in sync.
     */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // As uploaded. Display only -- never used to build a filesystem path,
    // because it is attacker-controlled and may contain "../".
    originalName: { type: String, required: true, trim: true, maxlength: 255 },

    // Server-generated UUID filename. The only value used for disk access.
    storedPath: { type: String, required: true },

    // Determined by sniffing magic bytes, never from the client's
    // Content-Type header or the file extension.
    mimeType: { type: String, required: true },

    sizeBytes: { type: Number, required: true, min: 0 },
    pageCount: { type: Number, default: null, min: 0 },
    chunkCount: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: DOCUMENT_STATUSES,
      default: 'uploaded',
      required: true,
    },

    // User-facing, plain English. Set alongside status: 'failed'.
    errorMessage: { type: String, default: null, maxlength: 500 },

    /*
     * Powers the stuck-state reaper (ADR 007). Fire-and-forget indexing means
     * a crashed Python process leaves a document at 'processing' forever;
     * nothing else would ever move it. The reaper finds anything processing
     * for more than ten minutes and fails it with a retryable message.
     */
    processingStartedAt: { type: Date, default: null },
    indexedAt: { type: Date, default: null },
  },
  baseSchemaOptions(),
);

// Listing a knowledge base's documents, newest first. ESR: equality on the
// parent, then sort.
documentSchema.index({ knowledgeBaseId: 1, createdAt: -1 });

// The tenancy check: findOne({ _id, userId }). Equality on both fields, so
// order between them barely matters -- userId leads for consistency with
// every other index here.
documentSchema.index({ userId: 1, _id: 1 });

// The reaper's query: status equality, then a range on the timestamp.
// Equality before range is the other half of ESR -- reversed, the scan would
// cover every document older than the cutoff regardless of status.
documentSchema.index({ status: 1, processingStartedAt: 1 });

export const Document = mongoose.model('Document', documentSchema);
