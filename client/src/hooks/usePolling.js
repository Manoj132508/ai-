import { useEffect, useRef } from 'react';

/**
 * Calls `callback` every `intervalMs` while `enabled` is true.
 *
 * THE INTERVAL IS ALWAYS CLEARED ON UNMOUNT. A polling hook that leaks its
 * interval keeps hammering the API from a component the user closed ten
 * minutes ago — and because the requests still succeed, nothing looks broken
 * until someone reads the server logs.
 *
 * `enabled` is a condition, not a switch to remember to flip: the document
 * list passes `documents.some(d => d.status === 'processing')`, so polling
 * stops by itself the moment there is nothing left to watch.
 *
 * The callback is held in a ref so that changing it does not restart the
 * timer. Without that, an inline arrow function -- a new identity every
 * render -- would tear down and recreate the interval continuously, and the
 * tick would effectively never fire.
 */
export function usePolling(callback, { intervalMs = 3000, enabled = true } = {}) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return undefined;

    const id = setInterval(() => savedCallback.current(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
}
