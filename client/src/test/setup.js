import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library mounts into a real jsdom document. Without an unmount
// between tests, each test's DOM would leak into the next, and queries like
// getByRole would find stale nodes from an earlier render -- a classic source
// of tests that pass alone but fail in a suite. `cleanup` unmounts everything
// after each test so every case starts from an empty document.
afterEach(() => {
  cleanup();
});
