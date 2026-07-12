import { Check, Copy } from 'lucide-react';

import { useCopyFeedback } from '../../hooks/useCopyFeedback';
import { cn } from '../../lib/utils';

/** Icon copy button (checkmark feedback) — shared across sids, file paths, etc.; size and reveal-on-hover timing vary via className */
export function CopyIconButton({ text, label, className }: Readonly<{ text: string; label: string; className?: string }>) {
  const { isCopied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 cursor-pointer rounded-sm text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground',
        className
      )}
      title={label}
      aria-label={label}
      onClick={() => void copy(text)}
    >
      {isCopied ? <Check className="text-subagent" /> : <Copy />}
    </button>
  );
}
