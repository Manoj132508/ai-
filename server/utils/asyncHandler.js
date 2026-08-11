/**
 * Forwards a rejected promise from an async route handler to `next()`.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Express 4 predates async/await. Its router calls your handler and ignores
 * the return value, so a rejected promise is never observed:
 *
 *   router.get('/kb/:id', async (req, res) => {
 *     const kb = await KnowledgeBase.findOne(...);   // throws
 *     res.json(kb);                                   // never runs
 *   });
 *
 * Nothing catches the rejection. `next(err)` is never called, so the error
 * handler never runs, no response is ever sent, and **the request hangs until
 * the client times out**. In Node 18+ it also logs an unhandled rejection,
 * which by default terminates the process. One missing try/catch can take
 * down the server.
 *
 * Wrapping in `asyncHandler` attaches a `.catch(next)`, so the rejection
 * enters the normal Express error pipeline like any synchronous throw.
 *
 * ALTERNATIVES CONSIDERED
 *
 *  - try/catch in every handler: works, but it is opt-in, so the one handler
 *    where someone forgets is the one that hangs.
 *  - `express-async-errors`: patches the router globally. Fewer keystrokes,
 *    but the mechanism becomes invisible -- a new reader cannot see why
 *    errors propagate.
 *  - Express 5: handles rejected promises natively, making this unnecessary.
 *    We are on 4.x for ecosystem stability; this is the wrapper to delete on
 *    upgrade.
 */
export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    // Promise.resolve() so the wrapper also works with non-async handlers.
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
