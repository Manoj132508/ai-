import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Spinner from './primitives/Spinner.jsx';

/**
 * Route guard for authenticated pages.
 *
 * THIS IS NOT SECURITY. It decides what to render; it does not protect data.
 * Anyone can open devtools, call the API directly, or disable JavaScript. The
 * real boundary is `requireAuth` on the server plus ownership-scoped queries —
 * this only spares a logged-out visitor a screen full of failed requests.
 *
 * Worth being able to say out loud in an interview: a frontend guard is a UX
 * affordance. Treating it as a security control is the mistake.
 */
export default function RequireAuth({ children }) {
  const { status } = useAuth();
  const location = useLocation();

  // The state that makes deep-linking work. Rendering the redirect while the
  // session is still unknown would bounce an authenticated user to /login on
  // every refresh.
  if (status === 'loading') {
    return (
      <div
        style={{
          minHeight: '60vh',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--color-muted)',
        }}
      >
        <Spinner size="lg" label="Checking your session" />
      </div>
    );
  }

  if (status === 'anonymous') {
    /*
     * `state.from` remembers where they were going, so logging in returns them
     * there instead of dumping everyone on the dashboard. `replace` keeps the
     * protected URL out of history — otherwise Back lands on the redirect and
     * bounces again.
     */
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
