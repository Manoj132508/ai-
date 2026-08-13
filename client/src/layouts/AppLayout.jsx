import { useEffect, useState, Suspense } from 'react';
import { Outlet, useLocation, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/primitives/Button.jsx';
import Spinner from '../components/primitives/Spinner.jsx';
import styles from './AppLayout.module.css';

/**
 * Shell for every authenticated screen: skip link, header, sidebar, main.
 *
 * Renders an <Outlet />, so it is used as a *layout route* in App.jsx. That
 * means the header and sidebar are not unmounted and remounted when the user
 * navigates between children -- which keeps scroll position, avoids a flash,
 * and (later) stops the sidebar refetching the knowledge base list on every
 * route change.
 */
export default function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  async function handleLogout() {
    setLoggingOut(true);
    await logout(); // never rejects: it clears local state in a finally block
    navigate('/login', { replace: true });
  }

  // Close the drawer whenever the route changes: on mobile the user taps a
  // link inside the drawer, and leaving it open would cover the page they
  // just asked for.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape closes the drawer. Expected of anything overlay-shaped, and cheap.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    // Cleanup matters: without it every open/close leaks another listener.
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  return (
    <div className={styles.shell}>
      {/*
        Skip link. Keyboard and screen-reader users otherwise tab through the
        entire sidebar on every single page before reaching the content.
        Visually hidden until focused -- see .skipLink in the stylesheet.
      */}
      <a href="#main" className={styles.skipLink}>
        Skip to main content
      </a>

      <header className={styles.header}>
        <button
          type="button"
          className={styles.drawerToggle}
          onClick={() => setDrawerOpen((open) => !open)}
          aria-expanded={drawerOpen}
          aria-controls="app-sidebar"
          aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
        >
          <span aria-hidden="true">{drawerOpen ? '✕' : '☰'}</span>
        </button>

        <span className={styles.brand}>AI Knowledge Assistant</span>

        <div className={styles.headerRight}>
          <span className={styles.user}>{user?.name ?? user?.email}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            loading={loggingOut}
          >
            Log out
          </Button>
        </div>
      </header>

      <div className={styles.body}>
        {/*
          The backdrop only exists while the drawer is open, so it cannot
          intercept clicks the rest of the time.
        */}
        {drawerOpen && (
          <div
            className={styles.backdrop}
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
        )}

        <nav
          id="app-sidebar"
          className={`${styles.sidebar} ${drawerOpen ? styles.sidebarOpen : ''}`}
          aria-label="Knowledge bases"
        >
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
            }
          >
            All knowledge bases
          </NavLink>

          <p className={styles.sidebarNote}>
            Open a knowledge base to ask questions of its documents.
          </p>
        </nav>

        {/* tabIndex={-1} makes the skip link's target focusable, so focus
            actually moves here rather than only scrolling. */}
        <main id="main" className={styles.main} tabIndex={-1}>
          {/* Suspense boundary for the code-split page chunks (App.jsx). It
              wraps only the Outlet, so while a route's chunk loads the header
              and sidebar stay put and just the content area shows a spinner. */}
          <Suspense
            fallback={
              <div style={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
                <Spinner size="lg" label="Loading" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
