import styles from './Spinner.module.css';

/**
 * Indeterminate loading indicator.
 *
 * Decorative by default (aria-hidden): the surrounding element is responsible
 * for announcing busy state via aria-busy, so a screen reader hears "loading"
 * once rather than once per spinner on the page.
 *
 * Pass a `label` only when the spinner is the *sole* indication of loading.
 */
export default function Spinner({ size = 'md', label }) {
  return (
    <span
      className={`${styles.spinner} ${styles[size]}`}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : 'true'}
    >
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}
