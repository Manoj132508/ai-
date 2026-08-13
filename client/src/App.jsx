import { lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

// Layouts and the auth guard are NOT lazy: they are small, and one of them is
// on screen for the very first paint, so splitting them would only add a
// network round-trip before anything renders.
import AppLayout from './layouts/AppLayout.jsx';
import AuthLayout from './layouts/AuthLayout.jsx';
import RequireAuth from './components/RequireAuth.jsx';

/*
 * Pages are code-split (Phase 13, performance).
 *
 * React.lazy turns each `import()` into its own chunk that Vite emits
 * separately and the browser fetches only when its route is first visited. The
 * payoff is concrete here: a logged-out visitor to /login no longer downloads
 * the dashboard, the knowledge-base view (which pulls in the chat stream and
 * markdown rendering), or anything else -- only the login chunk plus the shared
 * vendor code.
 *
 * The <Suspense> boundary these need lives in each layout, wrapped around its
 * <Outlet />, so a route change shows a spinner only in the content area while
 * the chunk loads -- the shell stays mounted.
 */
const LoginPage = lazy(() => import('./pages/LoginPage.jsx'));
const RegisterPage = lazy(() => import('./pages/RegisterPage.jsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const KnowledgeBasePage = lazy(() => import('./pages/KnowledgeBasePage.jsx'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.jsx'));

// The lazy() call is guarded by the build-time DEV literal, not just the route
// below. `lazy(() => import(...))` keeps the import() in the module body, so
// Rollup would emit the gallery chunk in production even though the route is
// dev-only. In a production build this ternary folds to `null` and the import()
// sits in dead code, so the chunk is never generated.
const ComponentGalleryPage = import.meta.env.DEV
  ? lazy(() => import('./pages/ComponentGalleryPage.jsx'))
  : null;

/*
 * Route table -- Phase 4, section 4.1.
 *
 * Structured as *layout routes*: a parent route renders the shell and an
 * <Outlet />, and its children render inside it. Two consequences worth
 * knowing:
 *
 *   - The shell is not remounted when navigating between siblings, so header
 *     and sidebar state (and later, the fetched KB list) survive navigation.
 *   - RequireAuth wraps the AppLayout route, which protects every child at
 *     once. Adding a new authenticated page then requires no auth wiring at
 *     all -- the impossible-to-forget version of a security rule.
 */
export default function App() {
  return (
    <Routes>
      {/* Unauthenticated */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      {/*
        Authenticated shell.
        <RequireAuth> wraps the LAYOUT, so every child route below inherits the
        guard. Adding a new authenticated page needs no auth wiring at all --
        the impossible-to-forget version of the rule. Note this protects
        NAVIGATION only; the real boundary is requireAuth on the server plus
        ownership-scoped queries.
      */}
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />

        {/* Chat is the default view for a knowledge base: the product's value
            is asking questions, not managing files. */}
        <Route path="/kb/:kbId" element={<KnowledgeBasePage view="chat" />} />
        <Route
          path="/kb/:kbId/documents"
          element={<KnowledgeBasePage view="documents" />}
        />
        <Route
          path="/kb/:kbId/settings"
          element={<KnowledgeBasePage view="settings" />}
        />

        {/* Dev-only styleguide. `import.meta.env.DEV` is a build-time literal,
            so in production the branch is dead code and Rollup drops the lazy
            import with it -- the gallery chunk is never emitted. */}
        {import.meta.env.DEV && (
          <Route path="/dev/components" element={<ComponentGalleryPage />} />
        )}

        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
