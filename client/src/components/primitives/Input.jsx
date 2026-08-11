import { useId } from 'react';
import styles from './Input.module.css';

/**
 * Labelled text input with inline error support.
 *
 * The label is always rendered and always tied to the input by id. A
 * placeholder is not a label: it disappears the moment someone types, so the
 * field becomes unidentifiable exactly when a user checks their answer, and
 * screen readers treat it inconsistently.
 *
 * `useId` generates a collision-free id, so two of these on one page (or the
 * same form rendered twice) cannot end up sharing a label.
 */
export default function Input({ label, error, hint, id, type = 'text', ...rest }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>

      <input
        id={inputId}
        type={type}
        className={`${styles.input} ${error ? styles.inputError : ''}`}
        // Tells assistive technology the field is invalid, which colour alone
        // does not.
        aria-invalid={error ? 'true' : undefined}
        // Points at the error and hint so they are read as part of the field,
        // rather than as loose text the user has to hunt for.
        aria-describedby={[error ? errorId : null, hint ? hintId : null]
          .filter(Boolean)
          .join(' ') || undefined}
        {...rest}
      />

      {hint && !error && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}

      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
