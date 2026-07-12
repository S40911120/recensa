import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro font-medium leading-none [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary/15 text-primary',
        // Neutral metadata chip (skills / advanced filters): uses the muted-foreground gray rather than the theme
        // --secondary accent, which shifts too much per theme (Academic rust-red to salmon, Dracula pink...) to hold up as a chip background. Gray stays legible across all themes.
        secondary: 'bg-muted-foreground/15 text-foreground/85',
        muted: 'bg-accent text-muted-foreground',
        destructive: 'bg-destructive/15 text-destructive',
        subagent: 'bg-subagent/15 text-subagent',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: Readonly<BadgeProps>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
