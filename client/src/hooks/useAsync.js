import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async function and tracks loading / data / error.
 *
 * TWO BUGS THIS EXISTS TO PREVENT, both of which are invisible on a fast
 * local network and routine on a slow one:
 *
 * 1. Setting state after unmount. The user navigates away mid-request; the
 *    promise resolves into a component that no longer exists.
 *
 * 2. The stale-response race. Two requests are in flight (the user typed, then
 *    typed again) and the FIRST resolves last, so the older result overwrites
 *    the newer one. A request counter fixes it: only the most recent call is
 *    allowed to write.
 *
 * `deps` behaves like useEffect's dependency array. Pass a stable `fn` --
 * define it with useCallback, or inline it and accept a re-run per render.
 */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });

  const latestCall = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const callId = ++latestCall.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const data = await fn();
      // Discard if unmounted, or if a newer call has since started.
      if (!mounted.current || callId !== latestCall.current) return;
      setState({ data, error: null, loading: false });
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!mounted.current || callId !== latestCall.current) return;
      setState({ data: null, error: err, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { ...state, reload: run };
}
