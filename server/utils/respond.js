/**
 * The single success envelope: `{ success, data, error }`.
 *
 * Every response from this API -- success or failure -- has the same three
 * top-level keys, so the client has exactly one shape to parse. `error` is
 * null on success; `data` is null on failure. Neither key is ever absent,
 * because `if (body.error)` behaves differently from `if ('error' in body)`
 * and a client should not have to know which.
 *
 * An explicit helper rather than a monkey-patched `res.ok()`: the import is
 * visible at the call site, so a reader can find the definition, and there is
 * no hidden mutation of the Express response object.
 */
export function ok(res, data, status = 200) {
  return res.status(status).json({
    success: true,
    data: data ?? null,
    error: null,
  });
}

/**
 * Success envelope for a paginated collection.
 *
 * Pagination metadata belongs beside the items, not merged into them: a client
 * that renders a page needs `total` and `hasMore` without having to infer them
 * from the array length, which is ambiguous on the final page.
 */
export function okPaginated(res, items, { page, limit, total }) {
  return res.status(200).json({
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasMore: page * limit < total,
      },
    },
    error: null,
  });
}

/** 204: success with deliberately no body. Envelope omitted -- 204 forbids one. */
export function noContent(res) {
  return res.status(204).end();
}
