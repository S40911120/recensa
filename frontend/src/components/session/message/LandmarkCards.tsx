import {
  Archive,
  CircleAlert,
  FileText,
  Inbox,
  Scissors,
  SquareChevronRight,
  Terminal,
  Users,
  Webhook,
} from 'lucide-react';

import { formatDateTime } from '../../../lib/format';
import { renderMarkdown } from '../../../lib/md';
import type { Message } from '../../../types';
import { CopyButton, FlatRow, joinText, type TextBlock } from './MessageParts';

/** Compaction-summary opening card: the condensed context text loaded after resume/compact (collapsed by default; the main conversation still shows normally) */
export function CompactCard({ textBlocks }: Readonly<{ textBlocks: TextBlock[] }>) {
  const text = joinText(textBlocks);
  return (
    <article className="rounded-lg border border-primary/40 border-l-[3px] border-l-primary bg-card px-3.5 py-2.5">
      <FlatRow
        icon={Archive}
        toneClass="text-primary"
        label={`Compacted context summary (${text.length.toLocaleString()} chars) — this session opens with compacted text`}
      >
        {text}
      </FlatRow>
    </article>
  );
}

/** hook / API event row */
export function HookRow({ message }: Readonly<{ message: Message }>) {
  if (message.apiError) {
    const retrySuffix = message.apiError.retryAttempt
      ? ` (retry ${message.apiError.retryAttempt}/${message.apiError.maxRetries ?? '?'})`
      : '';
    return (
      <FlatRow
        icon={CircleAlert}
        toneClass="text-destructive"
        label={`API error${retrySuffix}`}
      >
        {message.apiError.error}
      </FlatRow>
    );
  }
  const h = message.hook;
  if (!h) return null;
  const hasErrors = h.errors.length > 0;
  const errorsSuffix = hasErrors ? ` — ${h.errors.length} errors` : '';
  const blockedSuffix = h.preventedContinuation ? ' (blocked continuation)' : '';
  return (
    <FlatRow
      icon={Webhook}
      toneClass={hasErrors ? 'text-destructive' : 'text-tool'}
      accent={hasErrors ? undefined : 'var(--chart-6)'}
      label={`hooks ×${h.count}${errorsSuffix}${blockedSuffix}`}
    >
      {JSON.stringify({ infos: h.infos, errors: h.errors, additionalContext: h.additionalContext }, null, 2)}
    </FlatRow>
  );
}

/** Recap: an auto-generated session-progress summary produced when returning from away/idle (Claude Code /recap,
 *  recorded as subtype=away_summary). Orthogonal to compaction — doesn't replace history or touch context; a pure progress recap */
export function AwayCard({ textBlocks, meta }: Readonly<{ textBlocks: TextBlock[]; meta: string }>) {
  const text = joinText(textBlocks);
  return (
    <article className="group relative rounded-lg border border-subagent/35 border-l-[3px] border-l-subagent bg-card px-3.5 py-2.5">
      <CopyButton text={text} />
      <header className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-subagent [&_svg]:size-3.5">
        <FileText />
        Recap
      </header>
      <div className="markdown text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      {meta && <footer className="mt-1.5 text-right font-mono text-micro text-muted-foreground/80">{meta}</footer>}
    </article>
  );
}

/** A queued human message (a prompt queued while Claude was busy) */
export function QueuedRow({ textBlocks }: Readonly<{ textBlocks: TextBlock[] }>) {
  const text = joinText(textBlocks);
  return (
    <FlatRow icon={Inbox} toneClass="text-secondary" label={`Queued message (${text.length.toLocaleString()} chars)`}>
      {text}
    </FlatRow>
  );
}

/** Slash-command row (/compact, etc.) → a prominent single-line landmark, not buried inside a system injection */
export function CommandRow({ message }: Readonly<{ message: Message }>) {
  return (
    <div className="my-1 inline-flex items-center gap-1.5 rounded-md border border-secondary/40 bg-secondary/10 px-2 py-1 text-xs font-medium text-secondary-foreground [&_svg]:size-3.5">
      <SquareChevronRight className="text-secondary" />
      <span className="font-mono">{message.command ?? 'Command'}</span>
      {message.ts && <span className="text-micro font-normal text-muted-foreground">{formatDateTime(message.ts)}</span>}
    </div>
  );
}

/** Local command / system message (informational) → a flat row, color-coded by warning/error level */
export function SystemEventRow({ message, textBlocks }: Readonly<{ message: Message; textBlocks: TextBlock[] }>) {
  const text = joinText(textBlocks);
  const level = message.system?.level ?? 'info';
  const warnTone = level === 'warning' ? 'text-primary' : 'text-muted-foreground';
  const tone = level === 'error' ? 'text-destructive' : warnTone;
  const label = `${message.system?.label ?? 'System event'}${text ? '' : ' (no output)'}`;
  return (
    <FlatRow icon={Terminal} toneClass={tone} label={label}>
      {text || 'No content'}
    </FlatRow>
  );
}

/** Context-compaction boundary: a divider landmark (original text before this point has been replaced by a summary) */
export function BoundaryDivider({ ts }: Readonly<{ ts: string | null }>) {
  return (
    <div className="my-2 flex items-center gap-2 text-micro text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <Scissors className="size-3" />
      Compaction point{ts ? ` (${formatDateTime(ts)})` : ''}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Teammate (agent-team member) message: a dedicated green-bordered card; idle notices collapse to one line */
export function TeammateCard({ message, meta }: Readonly<{ message: Message; meta: string }>) {
  const t = message.teammate;
  if (!t) return null;
  if (t.idle) {
    return (
      <div className="my-0.5 inline-flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
        <Users className="size-3.5 text-subagent/70" />
        teammate "{t.id ?? '?'}" went idle
      </div>
    );
  }
  return (
    <article className="group relative rounded-lg border border-subagent/35 border-l-[3px] border-l-subagent bg-card px-3.5 py-2.5">
      <CopyButton text={t.inner} />
      <header className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 font-semibold text-subagent [&_svg]:size-3.5">
          <Users />
          teammate: {t.id ?? '?'}
        </span>
        {t.summary && <span className="text-muted-foreground">{t.summary}</span>}
      </header>
      <div
        className="markdown text-sm"
        // content is sanitized with DOMPurify (lib/md.ts)
        dangerouslySetInnerHTML={{ __html: renderMarkdown(t.inner) }}
      />
      {meta && <footer className="mt-1.5 text-right font-mono text-micro text-muted-foreground/80">{meta}</footer>}
    </article>
  );
}
