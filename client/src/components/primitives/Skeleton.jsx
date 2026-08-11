import styles from './Skeleton.module.css';

/**
 * Placeholder that occupies the same space the real content will.
 *
 * Why skeletons rather than a spinner (section 4.3): a skeleton preserves
 * layout, so nothing jumps when data lands. A centred spinner collapses the
 * container, then the content pushes the page around on arrival.
 *
 * Always aria-hidden -- it is a visual affordance with no meaning. The
 * container announces loading via aria-busy; see SkeletonGroup.
 */
export function Skeleton({ variant = 'text', width, height, className = '' }) {
  return (
    <span
      className={`${styles.skeleton} ${styles[variant]} ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

/**
 * Wraps a set of skeletons and carries the accessible announcement, so a
 * screen reader hears "Loading" once instead of once per placeholder.
 */
export function SkeletonGroup({ children, label = 'Loading' }) {
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
