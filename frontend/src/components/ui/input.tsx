import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground',
        'placeholder:text-muted-foreground/60',
        'focus-visible:outline-2 focus-visible:outline-primary/70',
        className
      )}
      {...props}
    />
  );
});
