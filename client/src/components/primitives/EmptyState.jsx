import styles from './EmptyState.module.css';

/**
 * Shown when a request succeeded but returned nothing.
 *
 * `action` is strongly encouraged, per the section 4.3 rule: an empty state
 * that only says "no documents" is a dead end. One that says "no documents --
 * upload one to start asking questions" is a path forward.
 *
 * Distinct from ErrorState: nothing failed here. Wording and tone should be
 * neutral, never apologetic.
 */
export default function EmptyState({ icon, title, description, action }) {
  return (
    <div className={styles.wrapper}>
      {icon && (
        <div className={styles.icon} aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
