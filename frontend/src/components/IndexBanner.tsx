import { LoadingDots } from './ui/loading';
import type { IndexStatus } from '../hooks/useIndexStatus';

/**
 * Indexing progress indicator: a **small floating pill** (bottom-left, position:fixed), shown while the backend is (re)indexing.
 * Deliberately not a top bar — fixed positioning gives "zero layout impact" (doesn't push content or interrupt reading flow), pointer-events-none so it never blocks clicks,
 * and it disappears once indexing completes. Hidden in zen focus mode (data-chrome).
 */
export function IndexBanner({ status }: Readonly<{ status: IndexStatus }>) {
  if (!status.indexing) return null;
  const known = status.total > 0;
  const label = known
    ? `Indexing ${status.done.toLocaleString()} / ${status.total.toLocaleString()}`
    : 'Indexing…';
  return (
    <div
      data-chrome
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-3 left-3 z-50 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur"
    >
      <LoadingDots />
      <span className="tabular-nums">{label}{known ? ` · ${status.pct}%` : ''}</span>
    </div>
  );
}
