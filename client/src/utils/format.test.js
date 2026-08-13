import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatBytes, formatRelativeTime } from './format.js';

describe('formatBytes', () => {
  it('shows raw bytes below 1000', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('uses decimal (1000) units, matching an OS file browser', () => {
    // 2_411_008 bytes is ~2.4 MB in decimal, NOT the 2.3 MiB a binary
    // (1024-based) formatter would show. This asserts the deliberate choice.
    expect(formatBytes(2_411_008)).toBe('2.4 MB');
    expect(formatBytes(1000)).toBe('1.0 kB');
  });

  it('drops the decimal once the value reaches 10 of a unit', () => {
    expect(formatBytes(15_000_000)).toBe('15 MB'); // 15, not 15.0
  });

  it('returns an em dash for nonsense input rather than NaN', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(Infinity)).toBe('—');
  });
});

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "just now" for the last 45 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(formatRelativeTime('2026-01-01T00:00:30Z')).toBe('just now');
  });

  it('formats minutes and hours in the past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    expect(formatRelativeTime('2026-01-01T11:57:00Z')).toBe('3 minutes ago');
    expect(formatRelativeTime('2026-01-01T10:00:00Z')).toBe('2 hours ago');
  });

  it('returns an em dash for missing or unparseable input', () => {
    expect(formatRelativeTime(null)).toBe('—');
    expect(formatRelativeTime('not-a-date')).toBe('—');
  });
});
