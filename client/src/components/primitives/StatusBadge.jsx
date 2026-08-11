import styles from './StatusBadge.module.css';

/**
 * Renders Document.status from the Mongo schema (section 3.2).
 *
 * The keys here must stay in step with the schema enum -- an unknown status
 * falls through to a visible "Unknown" rather than rendering blank, so a
 * schema change that misses this file shows up immediately instead of
 * silently producing empty badges.
 *
 * Colour is never the only signal: each state also has its own label and
 * glyph, so the badge still works for a colour-blind user or in greyscale.
 */
const STATUS = {
  uploaded: { label: 'Queued', glyph: '○', className: 'uploaded' },
  processing: { label: 'Processing', glyph: '◐', className: 'processing' },
  indexed: { label: 'Indexed', glyph: '●', className: 'indexed' },
  failed: { label: 'Failed', glyph: '✕', className: 'failed' },
};

export default function StatusBadge({ status }) {
  const entry = STATUS[status] ?? {
    label: 'Unknown',
    glyph: '?',
    className: 'uploaded',
  };

  return (
    <span className={`${styles.badge} ${styles[entry.className]}`}>
      <span className={styles.glyph} aria-hidden="true">
        {entry.glyph}
      </span>
      {entry.label}
    </span>
  );
}
