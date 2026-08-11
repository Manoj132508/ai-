import Button from './Button.jsx';
import styles from './ErrorState.module.css';

/**
 * Shown when a request failed.
 *
 * Three rules this component enforces so individual screens cannot forget them:
 *
 * 1. role="alert" -- a failure is announced to screen readers immediately,
 *    unlike an empty state, which is just content.
 * 2. Recovery is built in. `onRetry` renders a Retry button; if a screen has
 *    no retry path it must say so explicitly rather than silently omitting it.
 * 3. `code` is rendered small and muted. Users ignore it; it is there so a
 *    support screenshot carries the error taxonomy value from section 2.6.
 */
export default function ErrorState({
  title = 'Something went wrong',
  message,
  code,
  onRetry,
  retryLabel = 'Try again',
  retrying = false,
}) {
  return (
    <div className={styles.wrapper} role="alert">
      <div className={styles.icon} aria-hidden="true">
        !
      </div>
      <h3 className={styles.title}>{title}</h3>
      {message && <p className={styles.message}>{message}</p>}
      {onRetry && (
        <div className={styles.action}>
          <Button variant="secondary" onClick={onRetry} loading={retrying}>
            {retryLabel}
          </Button>
        </div>
      )}
      {code && <p className={styles.code}>{code}</p>}
    </div>
  );
}
