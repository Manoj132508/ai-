import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import RequireAuth from './RequireAuth.jsx';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * The route guard has three branches, one per auth state, and getting the
 * 'loading' one wrong is the classic "flash of the login page on every
 * refresh" bug. Auth is mocked so each state can be driven directly; the guard
 * is rendered inside a real router so <Navigate> actually navigates.
 */
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: vi.fn() }));

function renderGuardedApp() {
  return render(
    <MemoryRouter initialEntries={['/protected']}>
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireAuth>
              <div>secret content</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe('RequireAuth', () => {
  it('renders neither the page nor a redirect while the session is loading', () => {
    // The whole point of the third state: during 'loading' we must NOT redirect,
    // or a refresh would bounce an authenticated user to /login before /auth/me
    // has answered.
    vi.mocked(useAuth).mockReturnValue({ status: 'loading' });
    renderGuardedApp();

    expect(screen.queryByText('secret content')).toBeNull();
    expect(screen.queryByText('login page')).toBeNull();
  });

  it('redirects an anonymous visitor to /login', () => {
    vi.mocked(useAuth).mockReturnValue({ status: 'anonymous' });
    renderGuardedApp();

    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('secret content')).toBeNull();
  });

  it('renders the protected children for an authenticated user', () => {
    vi.mocked(useAuth).mockReturnValue({ status: 'authenticated' });
    renderGuardedApp();

    expect(screen.getByText('secret content')).toBeInTheDocument();
    expect(screen.queryByText('login page')).toBeNull();
  });
});
