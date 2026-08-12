import { useCallback, useEffect, useRef, useState } from 'react';

const CSRF_COOKIE = 'aika_csrf';

function readCsrfToken() {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${CSRF_COOKIE}=`))
    ?.split('=')[1];
}

/**
 * Streams an answer from the API.
 *
 * `fetch` rather than `EventSource`, for two reasons EventSource cannot do:
 * it only issues GET requests (so the question would have to go in the URL),
 * and it cannot set the CSRF header. The trade is that SSE framing has to be
 * parsed by hand -- which is the `buffer` handling below.
 */
export function useAsk({ knowledgeBaseId }) {
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState([]);
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | retrieving | streaming | done | error
  const [error, setError] = useState(null);
  const [conversationId, setConversationId] = useState(null);

  const controllerRef = useRef(null);

  // Abort any in-flight answer when the component unmounts. Without this the
  // request outlives the view and the server keeps generating tokens for an
  // answer that can never be displayed.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    // Leave ANY busy state, not just 'streaming'. Stopping during retrieval --
    // before the first token -- must also return the composer to idle, or the
    // spinner and Stop button stay up forever.
    setStatus((current) =>
      current === 'streaming' || current === 'retrieving' ? 'done' : current,
    );
  }, []);

  const ask = useCallback(
    async (question, { conversationId: existing } = {}) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setAnswer('');
      setCitations([]);
      setMeta(null);
      setError(null);
      // A distinct state before the first token: retrieval runs first, and a
      // blank panel reads as "nothing is happening".
      setStatus('retrieving');

      try {
        const response = await fetch(`/api/knowledge-bases/${knowledgeBaseId}/ask`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': readCsrfToken() ?? '',
          },
          body: JSON.stringify({ question, conversationId: existing ?? conversationId }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // A failure BEFORE the stream starts is a normal JSON envelope.
          const payload = await response.json().catch(() => null);
          throw Object.assign(new Error(payload?.error?.message ?? 'Something went wrong.'), {
            code: payload?.error?.code,
          });
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;

          // A network chunk can split an SSE frame in half, so the tail is
          // held back rather than parsed as though it were complete.
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            const event = JSON.parse(line.slice(6));

            if (event.type === 'conversation') {
              setConversationId(event.conversationId);
            } else if (event.type === 'meta') {
              setMeta(event);
            } else if (event.type === 'token') {
              setStatus('streaming');
              setAnswer((current) => current + event.text);
            } else if (event.type === 'citations') {
              setCitations(event.citations);
            } else if (event.type === 'error') {
              // Arrives mid-stream, after headers. The partial answer is kept
              // and the error shown beneath it rather than replacing it.
              setError({ code: event.code, message: event.message });
            } else if (event.type === 'done') {
              setStatus('done');
            }
          }
        }

        // The stream ended. If we are still busy -- the server sent an error
        // event but no trailing 'done', or the connection simply closed early
        // -- move to a terminal state so the composer un-busies. Without this
        // net the UI hangs on the spinner after a mid-stream failure.
        setStatus((current) =>
          current === 'retrieving' || current === 'streaming' ? 'done' : current,
        );
      } catch (err) {
        if (err.name === 'AbortError') return; // deliberate, not a failure
        setError({ code: err.code, message: err.message });
        setStatus('error');
      }
    },
    [knowledgeBaseId, conversationId],
  );

  return { ask, cancel, answer, citations, meta, status, error, conversationId };
}
