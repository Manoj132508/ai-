import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import Spinner from '../components/primitives/Spinner.jsx';
import styles from './AuthLayout.module.css';

/**
 * Shell for login and register: a centred card, no navigation.
 *
 * Deliberately has no sidebar or user menu -- there is no session yet, so
 * anything it could show would be either empty or a lie. Keeping auth on its
 * own layout also means the app shell never has to render a "logged out"
 * variant of itself.
 */
export default function AuthLayout() {
  return (
    <div className={styles.wrapper}>
      <main className={styles.card}>
        <h1 className={styles.brand}>AI Knowledge Assistant</h1>
        {/* Suspense boundary for the lazily-loaded login/register chunks. */}
        <Suspense
          fallback={
            <div style={{ display: 'grid', placeItems: 'center', minHeight: '8rem' }}>
              <Spinner label="Loading" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
