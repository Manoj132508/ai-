/**
 * Shared schema options, so serialisation rules cannot drift between models.
 *
 * The `toJSON` transform is a safety net, not the primary control. Every
 * document that reaches `res.json()` passes through it, so:
 *
 *   - `__v` is removed: Mongoose's version key is an implementation detail
 *     and leaking it invites clients to depend on it.
 *   - `_id` becomes `id`: the API should not expose which database it uses.
 *     Rename here once rather than in every controller.
 *   - Anything listed in a schema's `hiddenFields` is deleted.
 *
 * Password hashes are also `select: false` at the field level, so they are not
 * even loaded unless explicitly requested. Two independent mechanisms, because
 * a leaked credential hash is not a bug worth being clever about.
 */
export function baseSchemaOptions({ hiddenFields = [] } = {}) {
  return {
    timestamps: true, // createdAt / updatedAt, maintained by mongoose

    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id?.toString();
        delete ret._id;
        for (const field of hiddenFields) delete ret[field];
        return ret;
      },
    },

    toObject: { virtuals: true },
  };
}
