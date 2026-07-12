import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';

/** Section-header eyebrow (uppercase, tracked letter-spacing) — single source of truth for all section labels; icon optional */
export function SectionHeader({ icon: Icon, children, className }: Readonly<{ icon?: LucideIcon; children: ReactNode; className?: string }>) {
  return (
    <h3
      className={cn(
        'mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-eyebrow text-muted-foreground [&_svg]:size-3.5',
        className
      )}
    >
      {Icon && <Icon />}
      {children}
    </h3>
  );
}
