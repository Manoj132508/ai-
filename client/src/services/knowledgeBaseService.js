import { api, apiRequest } from './apiClient.js';

export const knowledgeBaseService = {
  list: ({ page = 1, limit = 12 } = {}, opts) =>
    api.get(`/knowledge-bases?page=${page}&limit=${limit}`, opts),

  get: (id, opts) => api.get(`/knowledge-bases/${id}`, opts),

  create: (payload) => api.post('/knowledge-bases', payload),

  update: (id, payload) => api.patch(`/knowledge-bases/${id}`, payload),

  remove: (id) => api.delete(`/knowledge-bases/${id}`),

  listDocuments: (id, { page = 1, limit = 20, status } = {}, opts) => {
    const params = new URLSearchParams({ page, limit });
    if (status) params.set('status', status);
    return api.get(`/knowledge-bases/${id}/documents?${params}`, opts);
  },

  /**
   * Uploads one file.
   *
   * Deliberately NOT using api.post: that JSON-encodes the body and sets
   * Content-Type: application/json. A multipart upload must let the browser
   * set Content-Type itself, because it has to append the boundary token the
   * server needs to split the parts. Setting it by hand produces a body the
   * server cannot parse, with a confusing error.
   */
  uploadDocument: (id, file, { signal } = {}) => {
    const form = new FormData();
    form.append('file', file);
    return apiRequest(`/knowledge-bases/${id}/documents`, {
      method: 'POST',
      rawBody: form,
      signal,
    });
  },
};
