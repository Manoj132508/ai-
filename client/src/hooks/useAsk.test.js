import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAsk } from './useAsk.js';

/**
 * useAsk hand-parses the SSE stream from POST /ask, so the tests feed it a fake
 * fetch whose response body is a reader we control byte-for-byte. That is the
 * only way to prove the two things that break silently: frame buffering across
 * network chunk boundaries, and the status machine (retrieving -> streaming ->
 * done, plus the mid-stream-error and cancel paths).
 */

const enc = new TextEncoder();

/** One SSE frame: `data: {json}\n\n`, the shape the server emits. */
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * A Response whose body.getReader() yields the given text chunks in order, then
 * {done:true}. Splitting a frame across two chunks here is exactly a TCP
 * segment boundary in production.
 */
function streamingResponse(...textChunks) {
  const items = textChunks.map((t) => ({ value: enc.encode(t), done: false }));
  let i = 0;
  const reader = {
    read: () => Promise.resolve(i < items.length ? items[i++] : { done: true }),
  };
  return { ok: true, status: 200, body: { getReader: () => reader } };
}

/** A controllable stream, for asserting intermediate state (cancel, spinner). */
function pausableStream() {
  let queue = [];
  let waiting = null;
  const emit = (item) => {
    if (waiting) { waiting(item); waiting = null; } else queue.push(item);
  };
  const reader = {
    read: () =>
      queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => { waiting = r; }),
  };
  return {
    response: { ok: true, status: 200, body: { getReader: () => reader } },
    push: (text) => emit({ value: enc.encode(text), done: false }),
    close: () => emit({ done: true }),
  };
}

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  document.cookie = 'aika_csrf=tok-123';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.cookie = 'aika_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('a full successful answer', () => {
  it('accumulates tokens in order and captures meta, citations and conversation id', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse(
        sse({ type: 'conversation', conversationId: 'c1' }),
        sse({ type: 'meta', topScore: 0.82 }),
        sse({ type: 'token', text: 'The notice ' }),
        sse({ type: 'token', text: 'is 30 days. [1]' }),
        sse({ type: 'citations', citations: [{ n: 1, documentName: 'handbook.pdf' }] }),
        sse({ type: 'done' }),
      ),
    );

    const { result } = renderHook(() => useAsk({ knowledgeBaseId: 'kb1' }));
    await act(async () => {
      await result.current.ask('how much notice?');
    });

    expect(result.current.answer).toBe('The notice is 30 days. [1]');
    expect(result.current.citations).toEqual([{ n: 1, documentName: 'handbook.pdf' }]);
    expect(result.current.conversationId).toBe('c1');
    expect(result.current.meta).toMatchObject({ topScore: 0.82 });
    expect(result.current.status).toBe('done');
    expect(result.current.error).toBe(null);
  });
});

describe('SSE frame boundaries', () => {
  it('reassembles a single frame split across two network chunks', async () => {
    const frame = sse({ type: 'token', text: 'Hi' });
    const mid = Math.floor(frame.length / 2);
    fetchMock.mockResolvedValue(
      streamingResponse(frame.slice(0, mid), frame.slice(mid), sse({ type: 'done' })),
    );

    const { result } = renderHook(() => useAsk({ knowledgeBaseId: 'kb1' }));
    await act(async () => {
      await result.current.ask('q');
    });

    // Parsed exactly once despite the split -- not dropped, not doubled.
    expect(result.current.answer).toBe('Hi');
  });

  it('parses two frames delivered in a single chunk', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse(
        sse({ type: 'token', text: 'a' }) + sse({ type: 'token', text: 'b' }),
        sse({ type: 'done' }),
      ),
    );

    const { result } = renderHook(() => useAsk({ knowledgeBaseId: 'kb1' }));
    await act(async () => {
      await result.current.ask('q');
    });

    expect(result.current.answer).toBe('ab');
  });
});

describe('failure paths', () => {
  it('keeps the partial answer when an error event arrives mid-stream', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse(
        sse({ type: 'token', text: 'partial answer' }),
        sse({ type: 'error', code: 'LLM_UNAVAILABLE', message: 'the model went away' }),
        // no trailing 'done': the stream just ends after the error.
      ),
    );

    const { result } = renderHook(() => useAsk({ knowledgeBaseId: 'kb1' }));
    await act(async () => {
      await result.current.ask('q');
    });

    // The partial answer is NOT discarded; the error is shown beneath it.
    expect(result.current.answer).toBe('partial answer');
    expect(result.current.error).toEqual({ code: 'LLM_UNAVAILABLE', message: 'the model went away' });
    // The fallback un-busies the composer even though no 'done' arrived.
    expect(result.current.status).toBe('done');
  });

  it('surfaces a pre-stream failure as an error status', async () => {
    // A failure BEFORE the stream starts is a normal JSON envelope, not SSE.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: 'AI_SERVICE_UNAVAILABLE', message: 'down' } }),
    });

    const { result } = renderHook(() => useAsk({ knowledgeBaseId: 'kb1' }));
    await act(async () => {
      await result.current.ask('q');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toEqual({ code: 'AI_SERVICE_UNAVAILABLE', message: 'down' });
  });
});

describe('cancellation', () => {
  it('cancel() during retrieval aborts the request and returns to a terminal state', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    const stream = pausableStream();
    fetchMock.mockResolvedValue(stream.response);

    const { result } = renderHook(() => useAsk({ knowledgeBaseId: 'kb1' }));

    let pending;
    await act(async () => {
      pending = result.current.ask('q');
      await Promise.resolve(); // let fetch resolve; reader.read() is now pending
    });
    expect(result.current.status).toBe('retrieving');

    act(() => {
      result.current.cancel();
    });

    expect(abortSpy).toHaveBeenCalled();
    // Cancelling before the first token still leaves the busy state, or the
    // spinner and Stop button would hang forever.
    expect(result.current.status).toBe('done');

    // Let the (now aborted) loop finish so no promise dangles past the test.
    await act(async () => {
      stream.close();
      await pending;
    });
  });

  it('aborts the in-flight request when the component unmounts', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    const stream = pausableStream();
    fetchMock.mockResolvedValue(stream.response);

    const { result, unmount } = renderHook(() => useAsk({ knowledgeBaseId: 'kb1' }));
    await act(async () => {
      result.current.ask('q');
      await Promise.resolve();
    });

    unmount();
    expect(abortSpy).toHaveBeenCalled();
  });
});
