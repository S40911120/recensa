import { describe, expect, it } from 'vitest';

import { formatDateTime, formatDuration, formatSize } from './format';

// Only timezone/locale-independent behavior is asserted here: the '—' fallbacks, duration math
// (an absolute getTime() difference), and byte formatting are deterministic across machines.
// The exact date/time strings from toLocaleString are host-locale dependent and are left untested.

describe('formatDateTime', () => {
  it('renders a missing timestamp as an em dash', () => {
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('returns null when either timestamp is missing', () => {
    expect(formatDuration(null, '2026-01-01T01:00:00Z')).toBeNull();
    expect(formatDuration('2026-01-01T00:00:00Z', null)).toBeNull();
  });

  it('returns null for a non-positive span', () => {
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBeNull();
  });

  it('formats a sub-hour span in minutes', () => {
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:45:00Z')).toBe('45m');
  });

  it('formats an hours-and-minutes span', () => {
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T01:30:00Z')).toBe('1h 30m');
  });

  it('formats a multi-day span in days and hours', () => {
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-02T01:00:00Z')).toBe('1d 1h');
  });
});

describe('formatSize', () => {
  it('formats sub-megabyte sizes in KB', () => {
    expect(formatSize(1500)).toBe('1 KB');
  });

  it('formats megabyte-scale sizes in MB with one decimal', () => {
    expect(formatSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
