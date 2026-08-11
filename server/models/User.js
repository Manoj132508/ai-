import mongoose from 'mongoose';
import { baseSchemaOptions } from './schemaOptions.js';

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      // NOTE: no `unique: true` here. That option is not a validator -- it is
      // shorthand for building an index, so pairing it with the explicit
      // schema.index() below declares the same index twice and Mongoose warns.
      // Every index in this codebase is declared in one place, after the
      // schema, so the full set can be read at a glance.
      lowercase: true, // normalised on write, so lookups need no case folding
      trim: true,
      maxlength: 254, // RFC 5321 maximum
    },

    passwordHash: {
      type: String,
      required: true,
      // Never loaded unless a query explicitly asks for it with
      // .select('+passwordHash'). Phase 8's login is the only place that
      // should. Combined with the toJSON transform below, the hash has to be
      // deliberately requested *and* deliberately serialised to escape.
      select: false,
    },

    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: 100,
    },
  },
  baseSchemaOptions({ hiddenFields: ['passwordHash'] }),
);

/*
 * The unique index is the constraint; application-level "is this email taken?"
 * checks are only a nicety.
 *
 * Two simultaneous registrations both pass a check-then-insert, because
 * neither has committed when the other checks. Only the index makes the second
 * insert fail. Phase 8 catches the resulting duplicate-key error (code 11000)
 * and returns a clean 409 -- the check exists to produce a good message, the
 * index exists to make the guarantee.
 */
userSchema.index({ email: 1 }, { unique: true });

export const User = mongoose.model('User', userSchema);
