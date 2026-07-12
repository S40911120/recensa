import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../../lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

type ContentProps = ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  title: string;
  /** bare = skip the default title bar (title is still exposed to assistive tech via sr-only); layout is fully owned by children —
   *  lets large dialogs with their own masthead (e.g. StatsDialog) reuse Radix's focus trap / Escape / focus restoration */
  chrome?: 'default' | 'bare';
};

export function DialogContent({ className, title, chrome = 'default', children, ...props }: ContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fade-in fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'panel-enter fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'rounded-lg border border-border bg-card shadow-lg',
          chrome === 'default' && 'w-[440px] max-w-[92vw] p-4',
          className
        )}
        {...props}
      >
        {chrome === 'bare' ? (
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        ) : (
          <div className="mb-3 flex items-center justify-between">
            <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="cursor-pointer rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
