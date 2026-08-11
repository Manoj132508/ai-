import { api } from './apiClient.js';

export const documentService = {
  get: (id, opts) => api.get(`/documents/${id}`, opts),
  remove: (id) => api.delete(`/documents/${id}`),
};
