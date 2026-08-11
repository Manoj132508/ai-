import { Routes, Route, Navigate } from 'react-router-dom';

import AppLayout from './layouts/AppLayout.jsx';
import AuthLayout from './layouts/AuthLayout.jsx';

import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import KnowledgeBasePage from './pages/KnowledgeBasePage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import ComponentGalleryPage from './pages/ComponentGalleryPage.jsx';
import RequireAuth from './components/RequireAuth.jsx';

/*
 * Route table -- Phase 4, section 4.1.
 *
 * Structured as *layout routes*: a parent route renders the shell and an
 * <Outlet />, and its children render inside it. Two consequences worth
 * knowing:
 *
 *   - The shell is not remounted when navigating between siblings, so header
 *     and sidebar state (and later, the fetched KB list) survive navigation.
 *   - Phase 8 wraps the AppLayout route in <RequireAuth>, which protects every
 *     child at once. Adding a new authenticated page then requires no auth
 *     wiring at all -- the impossible-to-forget version of a security rule.
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

        {/* Dev-only styleguide. `import.meta.env.DEV` is replaced with a
            literal at build time, so the branch and the gallery import are
            both tree-shaken out of the production bundle. */}
        {import.meta.env.DEV && (
          <Route path="/dev/components" element={<ComponentGalleryPage />} />
        )}

        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
