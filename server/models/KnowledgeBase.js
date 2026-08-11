import mongoose from 'mongoose';
import { baseSchemaOptions } from './schemaOptions.js';

const knowledgeBaseSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: 1,
      maxlength: 100,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },

    /*
     * Denormalised counts.
     *
     * The dashboard lists knowledge bases with a document count; computing it
     * live is an aggregation per card on every page load. Storing it turns
     * that into a field read.
     *
     * These can drift if a multi-step update fails midway. That is acceptable
     * *only* because they are advisory: the documents list is always computed
     * from the documents collection, so a stale count is a cosmetic bug, never
     * a correctness one. Only denormalise data you can afford to have slightly
     * wrong.
     */
    documentCount: { type: Number, default: 0, min: 0 },
    chunkCount: { type: Number, default: 0, min: 0 },
  },
  baseSchemaOptions(),
);

/*
 * ESR -- Equality, Sort, Range.
 *
 * `userId` is an equality match, so it comes first and narrows the index scan
 * to one user's slice. `createdAt` then serves the sort *within* that slice,
 * so MongoDB walks the index in order and never performs an in-memory sort.
 *
 * Reverse the fields and the index becomes nearly useless for this query: the
 * scan would start across every user's documents ordered by date, filtering as
 * it goes.
 */
knowledgeBaseSchema.index({ userId: 1, createdAt: -1 });

// Names unique per user, not globally -- two people may both have "HR
// Policies". A partial or compound unique index is the only way to express
// "unique within a tenant".
knowledgeBaseSchema.index({ userId: 1, name: 1 }, { unique: true });

export const KnowledgeBase = mongoose.model('KnowledgeBase', knowledgeBaseSchema);
