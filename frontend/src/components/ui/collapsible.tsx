import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../../lib/utils';

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

type ContentProps = ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>;

export function CollapsibleContent({ className, ...props }: Readonly<ContentProps>) {
  return <CollapsiblePrimitive.Content className={cn('collapsible-content', className)} {...props} />;
}
