import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { authService } from '../services/authService.js';

const AuthContext = createContext(null);

/**
 * Session state for the whole app.
 *
 * THREE STATES, NOT TWO. `user === null` is ambiguous — it means both "not
 * logged in" and "we have not asked yet". Collapsing them is what produces
 * the flash of the login page on every refresh: the app renders "logged out"
 * for the 80ms before /auth/me answers.
 *
 *   'loading'        we are asking the server
 *   'authenticated'  user is populated
 *   'anonymous'      confirmed no session
 */
export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);

  /*
   * Bootstrap. This runs on every full page load, which is exactly what makes
   * deep-linking work: a browser opened directly at /kb/abc has no in-memory
   * session, so the app has to ask the server who it is before it can decide
   * what to render.
   */
  useEffect(() => {
    const controller = new AbortController();

    authService
      .me({ signal: controller.signal })
      .then((data) => {
        setUser(data.user);
        setStatus('authenticated');
      })
      .catch((err) => {
        if (err.name === 'AbortError') return; // unmounted; do not touch state
        // A 401 here is the expected answer for a logged-out visitor, not an
        // error worth surfacing.
        setUser(null);
        setStatus('anonymous');
      });

    return () => controller.abort();
  }, []);

  const login = useCallback(async (credentials) => {
    const data = await authService.login(credentials);
    setUser(data.user);
    setStatus('authenticated');
    return data.user;
  }, []);

  const register = useCallback(async (payload) => {
    const data = await authService.register(payload);
    setUser(data.user);
    setStatus('authenticated');
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } finally {
      // Clear local state even if the request failed. Leaving the UI looking
      // logged in after the user asked to leave is worse than a stale cookie
      // that will expire on its own — and on a shared machine it is the more
      // dangerous of the two.
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo(
    () => ({ status, user, login, register, logout }),
    [status, user, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  // Throwing beats returning undefined: the failure appears at the component
  // that is misplaced, not three renders later as "cannot read property of
  // undefined".
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
