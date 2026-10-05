import { Braces, Check, ChevronRight, Copy, Eye, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

import { useCopyFeedback } from '../../../hooks/useCopyFeedback';
import { formatDateTime } from '../../../lib/format';
import { cn } from '../../../lib/utils';
import type { Block, Message } from '../../../types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible';

export type TextBlock = Extract<Block, { kind: 'text' }>;

export const joinText = (blocks: TextBlock[]): string => blocks.map((b) => b.text).join('\n');

export function metaText(message: Message): string {
  const parts: string[] = [];
  if (message.ts) parts.push(formatDateTime(message.ts));
  if (message.model) parts.push(message.effort ? `${message.model} (${message.effort})` : message.model);
  const u = message.usage;
  if (u) {
    const t: string[] = [];
    if (u.input_tokens) t.push(`in ${u.input_tokens.toLocaleString()}`);
    if (u.output_tokens) t.push(`out ${u.output_tokens.toLocaleString()}`);
    if (u.cache_read_input_tokens) t.push(`cache ${u.cache_read_input_tokens.toLocaleString()}`);
    if (t.length > 0) parts.push(t.join(' · '));
  }
  return parts.join(' · ');
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated, ${text.length.toLocaleString()} chars total)` : text;
}

/** Copy button in a message card's top-right corner (appears on hover; copies that message's raw text) */
export function CopyButton({ text }: Readonly<{ text: string }>) {
  const { isCopied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      className="absolute right-1.5 top-1.5 flex cursor-pointer items-center gap-1 rounded-sm bg-card/80 px-1.5 py-0.5 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      aria-label="Copy this message"
      title="Copy"
      onClick={() => void copy(text)}
    >
      {isCopied ? (
        <><Check className="size-3 text-subagent" /><span className="text-micro text-subagent">Copied</span></>
      ) : (
        <><Copy className="size-3" /><span className="text-micro">Copy</span></>
      )}
    </button>
  );
}

/** Dual view for structured blocks: friendly rendering (pretty) ↔ raw structure (source, raw JSON/text), toggled by a top-right button.
 *  Used for structured blocks that have a prettified presentation (AskUserQuestion, Edit/Write diff) — you can always switch back to the original JSON structure. */
export function StructuredView({ pretty, source }: Readonly<{ pretty: React.ReactNode; source: string }>) {
  const [showSource, setShowSource] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-end">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3"
          title={showSource ? 'Show the formatted view' : 'Show the raw structure (source)'}
          aria-pressed={showSource}
          onClick={() => setShowSource((s) => !s)}
        >
          {showSource ? <><Eye />Formatted</> : <><Braces />View source</>}
        </button>
      </div>
      {showSource ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">{source}</pre>
      ) : (
        pretty
      )}
    </div>
  );
}

/** Flat expandable row: shared by tool_call / tool_result / thinking / injected messages (not a card).
 *  accent (optional): colors the icon only — a tool_use and its tool_result carry the same tool color, so for
 *  out-of-order responses you can pair a result with its call at a glance (without reordering messages). No left color bar,
 *  to avoid competing with the left border (border-l) of human/assistant cards for visual hierarchy. */
export function FlatRow({
  icon: Icon,
  label,
  toneClass,
  accent,
  children,
}: Readonly<{
  icon: LucideIcon;
  label: React.ReactNode;
  toneClass: string;
  accent?: string;
  children: React.ReactNode;
}>) {
  return (
    <Collapsible className="my-0.5">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs cursor-pointer',
          'hover:bg-accent/60 [&_svg]:size-3.5',
          toneClass
        )}
      >
        <ChevronRight className="shrink-0 text-muted-foreground/70 transition-transform duration-150 group-data-[state=open]:rotate-90" />
        <Icon className="shrink-0" style={accent ? { color: accent } : undefined} />
        <span className="truncate">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="my-1 ml-6 max-h-[430px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-code-bg p-2.5 font-mono text-xs leading-relaxed">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
