import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    // Requests to /api are forwarded to the Express API. The browser therefore
    // only ever talks to localhost:5177, so dev is same-origin: the auth cookie
    // is sent without CORS configuration or `credentials: 'include'` quirks.
    proxy: {
      '/api': {
        target: 'http://localhost:4200',
        changeOrigin: true,
      },
    },
  },
});
