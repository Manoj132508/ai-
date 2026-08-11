import { api } from './apiClient.js';

/**
 * Auth endpoints.
 *
 * A thin layer on purpose: it exists so components never contain URL strings,
 * which is what makes an API change a one-file edit instead of a search.
 *
 * Note there is no `getToken`. The session lives in an httpOnly cookie the
 * browser attaches automatically, so there is nothing for the client to hold,
 * store, or accidentally log (ADR 003).
 */
export const authService = {
  register: (payload) => api.post('/auth/register', payload),
  login: (payload) => api.post('/auth/login', payload),
  logout: () => api.post('/auth/logout'),
  me: (opts) => api.get('/auth/me', opts),
};
