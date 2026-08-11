import styles from './Skeleton.module.css';

/**
 * Placeholder that occupies the same space the real content will.
 *
 * Skeletons rather than a spinner (section 4.3): a skeleton preserves layout,
 * so nothing jumps when data lands. A centred spinner collapses the container
 * and the content shoves the page around on arrival.
 *
 * Always aria-hidden — a visual affordance with no meaning.
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
 * Marks a region as busy. NOT a live region — see LiveStatus below.
 *
 * FIXED FROM PHASE 5. This originally carried role="status", which implies
 * aria-live="polite". That was harmless while it only ever wrapped skeletons,
 * but the correct pattern keeps a PERSISTENT container and swaps its children
 * when loading finishes — and the moment a live region contains the real
 * content, the screen reader announces the entire document list on arrival.
 *
 * Busy state and the announcement are separate concerns, so they are now
 * separate elements:
 *
 *   <SkeletonGroup busy={loading}>        persistent, not live
 *     {loading ? <skeletons/> : <content/>}
 *   </SkeletonGroup>
 *   <LiveStatus>{loading ? 'Loading…' : `${n} loaded`}</LiveStatus>
 */
export function SkeletonGroup({ children, busy = true }) {
  return <div aria-busy={busy || undefined}>{children}</div>;
}

/**
 * A small, visually hidden live region.
 *
 * Small on purpose: everything inside it is read aloud when it changes, so it
 * should hold one short sentence and never the content itself.
 */
export function LiveStatus({ children }) {
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {children}
    </div>
  );
}
