import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `vitest/config` re-exports Vite's defineConfig with the `test` field added,
// so the dev server config and the test config share one transform pipeline --
// the whole reason to use Vitest over Jest in a Vite project.
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
  test: {
    // jsdom gives the tests a DOM (document, window, fetch is polyfilled by the
    // runner) so component and hook tests run headless in Node.
    environment: 'jsdom',
    // No need to import describe/it/expect in every file.
    globals: true,
    // Runs once before the suite: registers jest-dom matchers and cleanup.
    setupFiles: './src/test/setup.js',
    // Only our own tests; never descend into installed packages.
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
});
