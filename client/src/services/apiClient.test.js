import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, apiRequest, ApiRequestError } from './apiClient.js';

/**
 * apiClient is the single choke point for every request, so its invariants --
 * credentials, the CSRF header on unsafe methods, envelope unwrapping, and the
 * error-code mapping -- are the ones most worth pinning down. fetch is mocked;
 * no server is involved.
 */

/** Build a minimal Response-like object the way the real fetch would. */
function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // A readable CSRF cookie, as the server sets after login.
  document.cookie = 'aika_csrf=tok-123';
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Expire the cookie so it does not leak into the next test.
  document.cookie = 'aika_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('request shaping', () => {
  it('prefixes /api, sends credentials, and unwraps data from the envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { items: [1, 2] } }));

    const data = await api.get('/knowledge-bases');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/knowledge-bases');
    expect(opts.credentials).toBe('include');
    // The caller gets data directly; the envelope is not their concern.
    expect(data).toEqual({ items: [1, 2] });
  });

  it('does NOT attach a CSRF header on a safe method', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));
    await api.get('/anything');
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('attaches the CSRF header from the cookie on an unsafe method', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: {} }));
    await api.post('/knowledge-bases', { name: 'KB' });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-CSRF-Token']).toBe('tok-123');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.body).toBe(JSON.stringify({ name: 'KB' }));
  });

  it('sends a rawBody (FormData) as-is and sets no Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: {} }));
    const form = new FormData();
    form.append('file', 'x');

    await apiRequest('/documents', { method: 'POST', rawBody: form });

    const [, opts] = fetchMock.mock.calls[0];
    // Leaving Content-Type unset lets the browser add the multipart boundary.
    expect(opts.headers['Content-Type']).toBeUndefined();
    expect(opts.body).toBe(form);
  });
});

describe('responses', () => {
  it('returns null for 204 without trying to parse a body', async () => {
    // The json() here THROWS, exactly as parsing an empty 204 body would. The
    // test passes only because apiClient returns early on 204 and never calls
    // it -- that early return is what is being asserted.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => { throw new Error('204 has no body to parse'); },
    });

    const result = await apiRequest('/conversations/abc', { method: 'DELETE' });
    expect(result).toBe(null);
  });
});

describe('error mapping', () => {
  it('throws ApiRequestError carrying the server code, status and requestId', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, data: null, error: { code: 'KB_NOT_FOUND', message: 'gone', requestId: 'r1' } },
        { ok: false, status: 404 },
      ),
    );

    await expect(api.get('/knowledge-bases/x')).rejects.toMatchObject({
      name: 'ApiRequestError',
      code: 'KB_NOT_FOUND',
      status: 404,
      requestId: 'r1',
    });
  });

  it('maps a non-JSON body to INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    await expect(api.get('/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('maps a fetch rejection to NETWORK_ERROR with status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.get('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('re-throws an AbortError unchanged, so a cancel is not treated as a failure', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValue(abort);

    await expect(api.get('/x')).rejects.toThrow('aborted');
    // Not wrapped: still the raw AbortError, not an ApiRequestError.
    await expect(api.get('/x')).rejects.not.toBeInstanceOf(ApiRequestError);
  });
});
