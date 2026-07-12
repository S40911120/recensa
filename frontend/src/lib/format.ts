// Single source for date/time formatting; a missing timestamp always renders as '—'.
// Locale is left undefined so rendering follows the host locale; centralizing it here means
// pinning a specific locale later only needs to change this one place.
const LOCALE: string | undefined = undefined;

/** Full date and time: 2026/7/10 14:30:05 */
export function formatDateTime(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(LOCALE, { hour12: false });
}

/** Month/day + hours/minutes (for tight spots like compaction-node chips): 7/10 14:30 */
export function formatMonthDayTime(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(LOCALE, { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Time of day (for same-day sequences such as edit history): 14:30:05 */
export function formatTimeOfDay(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(LOCALE, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Session duration (span between first and last message) → "3h 24m" style; returns null when a timestamp is missing */
export function formatDuration(firstTs: string | null, lastTs: string | null): string | null {
  if (!firstTs || !lastTs) return null;
  const ms = new Date(lastTs).getTime() - new Date(firstTs).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}
