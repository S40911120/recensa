import { cn } from '../../lib/utils';

/** Recensa brand mark — the transparent robot-inspector logo (served from /logo.png). */
export function RecensaIcon({ className }: Readonly<{ className?: string }>) {
  return <img src="/logo.png" alt="Recensa" className={cn('object-contain', className)} />;
}

/** Three-dot bouncing loading indicator (for small / inline loading states) */
export function LoadingDots({ className, label }: Readonly<{ className?: string; label?: string }>) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm text-muted-foreground', className)}>
      <span className="inline-flex gap-1" aria-hidden>
        <span className="loading-dot size-1.5 rounded-full bg-current" style={{ animationDelay: '0ms' }} />
        <span className="loading-dot size-1.5 rounded-full bg-current" style={{ animationDelay: '160ms' }} />
        <span className="loading-dot size-1.5 rounded-full bg-current" style={{ animationDelay: '320ms' }} />
      </span>
      {label && <span>{label}</span>}
    </span>
  );
}

/** Message skeleton: pulsing placeholder cards (for the first load of the main conversation stream) */
export function MessageSkeleton({ rows = 5 }: Readonly<{ rows?: number }>) {
  return (
    <output className="flex flex-col gap-3" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => {
        // Alternating widths and tall/short cards to better mimic a real conversation stream
        const wide = i % 3 !== 1;
        return (
          <div
            key={i}
            className={cn('rounded-lg border border-border p-3.5', wide ? 'w-full' : 'w-[78%]')}
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <div className="skeleton mb-2 h-3.5 w-[40%]" />
            <div className="skeleton mb-1.5 h-3 w-full" />
            <div className="skeleton mb-1.5 h-3 w-[92%]" />
            {wide && <div className="skeleton h-3 w-[64%]" />}
          </div>
        );
      })}
    </output>
  );
}
