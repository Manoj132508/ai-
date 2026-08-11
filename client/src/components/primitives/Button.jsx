import Spinner from './Spinner.jsx';
import styles from './Button.module.css';

/**
 * The only button in the app.
 *
 * Two details that matter:
 *
 * 1. `loading` sets both `disabled` and `aria-busy`. Disabled alone stops the
 *    double-submit; aria-busy is what tells a screen reader something is in
 *    flight. Neither replaces the other.
 *
 * 2. The label stays visible while loading and the spinner is added beside it.
 *    Swapping label for spinner changes the button's width mid-click, which
 *    shifts everything next to it -- and loses the only clue about what is
 *    actually happening.
 */
export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  fullWidth = false,
  ...rest
}) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      className={[
        styles.button,
        styles[variant],
        styles[size],
        fullWidth ? styles.fullWidth : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size="sm" />}
      <span>{children}</span>
    </button>
  );
}
