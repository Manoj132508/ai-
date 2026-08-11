/**
 * The only place the app talks to the API.
 *
 * Centralising it means credentials, the CSRF header and envelope unwrapping
 * cannot be forgotten at a call site — the usual way one request in twenty
 * ends up unauthenticated for reasons nobody can reproduce.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE = 'aika_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

/** An API failure carrying the server's stable error code. */
export class ApiRequestError extends Error {
  constructor({ code, message, requestId, details, status }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.requestId = requestId; // quote this in a bug report — it traces both services
    this.details = details;
  }
}

/**
 * Reads the CSRF cookie.
 *
 * This is readable precisely because the server does NOT mark it httpOnly:
 * the double-submit scheme needs the client to echo it in a header. Safe,
 * because the token is not a credential — it only proves the request came
 * from a page that could read our cookie, which the same-origin policy denies
 * to any attacker's site.
 */
function readCsrfToken() {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${CSRF_COOKIE}=`))
    ?.split('=')[1];
}

/**
 * @param rawBody  A FormData (or similar) to send as-is. Content-Type is then
 *                 left unset ON PURPOSE so the browser can add the multipart
 *                 boundary token; setting it by hand yields a body the server
 *                 cannot split into parts.
 */
export async function apiRequest(path, { method = 'GET', body, rawBody, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (!SAFE_METHODS.has(method)) {
    const token = readCsrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal,
      /*
       * 'include' rather than the 'same-origin' default.
       *
       * In development the Vite proxy makes this same-origin, so either value
       * works. In production the SPA is on CloudFront and the API on another
       * origin, where 'same-origin' would silently drop the auth cookie and
       * every request would 401. Setting it once here means the same code
       * works in both, and pairs with the server's
       * Access-Control-Allow-Credentials.
       */
      credentials: 'include',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err; // deliberate cancellation, not a failure
    throw new ApiRequestError({
      code: 'NETWORK_ERROR',
      message: 'Could not reach the server. Check your connection and try again.',
      status: 0,
    });
  }

  // 204 has no body by definition; parsing it would throw.
  if (response.status === 204) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError({
      code: 'INVALID_RESPONSE',
      message: 'The server returned an unexpected response.',
      status: response.status,
    });
  }

  if (!response.ok || payload?.success === false) {
    throw new ApiRequestError({ ...payload?.error, status: response.status });
  }

  // Callers get `data` directly; the envelope is an API detail, not a UI one.
  return payload.data;
}

export const api = {
  get: (path, opts) => apiRequest(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => apiRequest(path, { ...opts, method: 'POST', body }),
  patch: (path, body, opts) => apiRequest(path, { ...opts, method: 'PATCH', body }),
  delete: (path, opts) => apiRequest(path, { ...opts, method: 'DELETE' }),
};
