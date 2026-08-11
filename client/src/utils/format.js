/** 2411008 -> "2.4 MB". Decimal units, matching what an OS file browser shows. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * "3 minutes ago", "2 days ago".
 *
 * Uses Intl.RelativeTimeFormat rather than a hand-rolled table, so it
 * pluralises and localises correctly without a date library.
 */
export function formatRelativeTime(isoString) {
  if (!isoString) return '—';
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 2592000) return rtf.format(Math.round(seconds / 86400), 'day');
  return new Date(isoString).toLocaleDateString();
}
