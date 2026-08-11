/**
 * Logs one line per completed request.
 *
 * Hooks the response's `finish` event rather than logging at the top of the
 * chain, because the interesting facts -- status code and duration -- only
 * exist once the response is done. Logging on the way in would produce two
 * lines per request with no status on either.
 *
 * `close` is handled too: it fires when the client disconnects before the
 * response completes. Without it, an abandoned request logs nothing at all
 * and simply vanishes -- and that is precisely the case we care about for the
 * SSE cancellation path (a user closing the tab mid-answer). Logging it with
 * an explicit `aborted: true` is what lets us tell "the user left" apart from
 * "we crashed" in the metrics.
 */
export function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  let logged = false;

  const write = (aborted) => {
    if (logged) return; // finish and close can both fire
    logged = true;

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // On an aborted request `res.statusCode` is still Express's default 200
    // even though nothing was sent. Logging that would record a failed
    // request as a success and quietly inflate the success rate, so report
    // null instead -- there genuinely was no status.
    const status = aborted ? null : res.statusCode;

    req.log.info('request', {
      method: req.method,
      path: req.originalUrl,
      status,
      durationMs: Math.round(durationMs * 100) / 100,
      ...(aborted ? { aborted: true, reason: 'client_disconnect' } : {}),
    });
  };

  res.on('finish', () => write(false));
  res.on('close', () => {
    // `close` also fires after a normal finish; only treat it as an abort if
    // the response never completed.
    if (!res.writableEnded) write(true);
  });

  next();
}
