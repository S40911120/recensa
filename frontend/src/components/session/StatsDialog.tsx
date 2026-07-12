import { BarChart3, FileEdit, FilePlus, Gauge, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { formatDuration, formatTimeOfDay } from '../../lib/format';
import { lineDiff, type DiffRow } from '../../lib/linediff';
import { highlightCode } from '../../lib/md';
import { estimateCost, formatCost } from '../../lib/pricing';
import { fetchSessionStats } from '../../lib/statsCache';
import { cn, errMessage } from '../../lib/utils';
import type { FileEditRecord, SessionStats } from '../../services/api';
import type { SessionDetail } from '../../types';
import { CopyIconButton } from '../ui/copy-icon-button';
import { Dialog, DialogContent, DialogTrigger } from '../ui/dialog';
import { SectionHeader } from '../ui/section-header';

/** Stats palette — reads the theme chart variables (SoT lives in each theme block in styles.css, auto-following the active theme;
 *  KPIs take named colors, the pie/bars cycle through the sequence) */
const C = {
  blue: 'var(--chart-1)',
  orange: 'var(--chart-2)',
  green: 'var(--chart-3)',
  violet: 'var(--chart-4)',
  red: 'var(--chart-5)',
  cyan: 'var(--chart-6)',
  magenta: 'var(--chart-7)',
  amber: 'var(--chart-8)',
} as const;
const PIE_COLORS = Object.values(C);
const pct = (n: number, total: number) => Math.round((n / Math.max(1, total)) * 100);

type TabId = 'overview' | 'edits' | 'created' | 'deleted';
const TABS: { id: TabId; label: string; icon: typeof FileEdit }[] = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'edits', label: 'Edits', icon: FileEdit },
  { id: 'created', label: 'Created', icon: FilePlus },
  { id: 'deleted', label: 'Deleted', icon: Trash2 },
];

/** Split highlight.js output into per-line HTML without breaking multi-line token spans.
 *  A comment/string that spans several source lines is a single <span> in hljs output (open tag
 *  on the first line, close on the last); a naive html.split('\n') orphans those tags and
 *  mis-colors every continuation line. Here open spans are re-emitted at the start of each line
 *  and closed at its end, so every line is self-contained, valid HTML with correct colors. */
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = []; // opening <span …> tags currently in effect
  let buf = '';
  const tokens = /<span\b[^>]*>|<\/span>|<[^>]*>|[^<]+/g;
  for (let m = tokens.exec(html); m !== null; m = tokens.exec(html)) {
    const t = m[0];
    if (t.startsWith('<span')) {
      open.push(t);
      buf += t;
    } else if (t === '</span>') {
      open.pop();
      buf += t;
    } else if (t.startsWith('<')) {
      buf += t; // any other tag: pass through, does not affect the span stack
    } else {
      const parts = t.split('\n');
      buf += parts[0];
      for (let i = 1; i < parts.length; i++) {
        lines.push(buf + '</span>'.repeat(open.length));
        buf = open.join('') + parts[i];
      }
    }
  }
  lines.push(buf + '</span>'.repeat(open.length));
  return lines;
}

function CodeBlock({ code, filePath }: Readonly<{ code: string; filePath?: string }>) {
  // Highlight + line-split are memoized: highlightAuto is costly and this row re-renders on
  // sibling expand/collapse. splitHighlightedLines keeps multi-line syntax spans intact per line.
  const lines = useMemo(() => splitHighlightedLines(highlightCode(code, filePath || '')), [code, filePath]);
  return (
    <div className="overflow-auto rounded border border-border bg-code-bg text-xs">
      <table className="w-full border-collapse font-mono leading-relaxed">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="sticky left-0 w-12 select-none border-r border-border bg-muted/40 px-1 text-right text-micro text-muted-foreground/60 align-top">{i + 1}</td>
              <td className="px-2 whitespace-pre align-top" dangerouslySetInnerHTML={{ __html: l }} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Pie chart + legend (a separate component to isolate hover state); the container is responsive and stacks vertically when narrow */
function PieSection({ data, total }: Readonly<{ data: { name: string; value: number; color: string }[]; total: number }>) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const display = data.length ? data : [{ name: '—', value: 1, color: '#94a3b8' }];
  return (
    <div className="flex flex-col items-center gap-2 lg:flex-row lg:items-start lg:gap-8">
      <div className="w-full max-w-[320px] shrink-0">
        <ResponsiveContainer width="100%" aspect={1}>
          <PieChart>
            <Pie data={display} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius="88%" innerRadius="46%" stroke="none"
              onMouseEnter={(_: unknown, index: number) => setActiveIndex(index)} onMouseLeave={() => setActiveIndex(null)}>
              {display.map((d, i) => <Cell key={d.name} fill={d.color} opacity={activeIndex != null && activeIndex !== i ? 0.35 : 1} />)}
            </Pie>
            <Tooltip formatter={(v: unknown) => `${Number(v)} (${pct(Number(v), total)}%)`} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex w-full min-w-0 flex-1 flex-col gap-0.5 lg:pt-2">
        {!data.length && <p className="px-2 text-sm text-muted-foreground">No tool use</p>}
        {data.map((d, i) => (
          <button type="button" key={d.name}
            className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-sm border-0 bg-transparent px-2 py-1 text-left text-sm transition-all hover:bg-accent/60', activeIndex === i && 'bg-accent/60 font-semibold', activeIndex != null && activeIndex !== i && 'opacity-40')}
            onMouseEnter={() => setActiveIndex(i)} onMouseLeave={() => setActiveIndex(null)}
            onFocus={() => setActiveIndex(i)} onBlur={() => setActiveIndex(null)}>
            <span className="w-5 text-right font-mono text-micro tabular-nums text-muted-foreground/70">{String(i + 1).padStart(2, '0')}</span>
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: d.color }} />
            {/* Name: on mobile, flex-1 expands to push the %/count to a fixed right edge (the thin bar is hidden on mobile, and without the flex-1 spacer the layout goes ragged);
                only on desktop does it shrink to max-w-[45%] flex-none, letting the thin bar below take flex-1 and fill the middle */}
            <span className="min-w-0 flex-1 truncate font-medium sm:max-w-[45%] sm:flex-none">{d.name}</span>
            {/* Proportion bar fills the gap between the name and the number (a fixed width used to leave a large broken blank in the middle) */}
            <span className="hidden h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-accent sm:block">
              <span className="block h-full rounded-full" style={{ width: `${pct(d.value, total)}%`, background: d.color }} />
            </span>
            <span className="w-9 text-right text-micro tabular-nums text-muted-foreground">{pct(d.value, total)}%</span>
            <span className="w-14 text-right font-mono text-xs tabular-nums">{d.value.toLocaleString()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Model-usage ranking: horizontal bars (most-used to least) */
function ModelRanking({ models }: Readonly<{ models: { name: string; count: number }[] }>) {
  const max = Math.max(1, ...models.map((m) => m.count));
  return (
    <section>
      <SectionHeader className="mb-3">Model usage · {models.length}</SectionHeader>
      <div className="flex flex-col gap-1.5">
        {models.map((m, i) => (
          <div key={m.name} className="flex items-center gap-3">
            <span className="w-5 text-right font-mono text-micro tabular-nums text-muted-foreground/70">{String(i + 1).padStart(2, '0')}</span>
            <span className="w-48 truncate font-mono text-xs sm:w-64" title={m.name}>{m.name}</span>
            <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-accent">
              <span
                className="block h-full rounded-full"
                style={{ width: `${Math.max(2, Math.round((m.count / max) * 100))}%`, background: PIE_COLORS[i % PIE_COLORS.length] }}
              />
            </span>
            <span className="w-16 text-right font-mono text-xs tabular-nums">{m.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** File basename (handles both forward and back slashes) */
const baseName = (p: string): string => {
  const parts = p.split(/[/\\]/);
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i]) return parts[i];
  return p;
};

/** Shortened directory display: keep the last 3 segments (the full path is available via the title tooltip and copy button) */
function shortDir(p: string): string {
  const parts = p.replaceAll('\\', '/').split('/').filter(Boolean);
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) return '';
  return (dirs.length > 3 ? '…/' : '') + dirs.slice(-3).join('/');
}

/** Copy-full-path button (appears when hovering the row) — reuses CopyIconButton, carrying only the reveal-timing styles */
function CopyPathButton({ path }: Readonly<{ path: string }>) {
  return (
    <CopyIconButton
      text={path}
      label="Copy full path"
      className="p-1.5 opacity-100 transition-opacity focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [&_svg]:size-3.5"
    />
  );
}

/** File row + expandable content: the Edits/Created tabs share one skeleton (icon and expanded content passed in separately) */
function FileRow({
  file,
  icon,
  right,
  expanded,
  onToggle,
  children,
}: Readonly<{
  file: SessionStats['files'][number];
  icon: ReactNode;
  right?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}>) {
  return (
    <div>
      <div className="group/row -mx-2 flex items-center gap-0.5">
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60',
            expanded && 'bg-accent/50 font-medium'
          )}
          title={file.path}
          onClick={onToggle}
        >
          {icon}
          <span className="max-w-[50%] shrink-0 truncate font-mono">{baseName(file.path)}</span>
          <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground/60">{shortDir(file.path)}</span>
          {right}
        </button>
        <CopyPathButton path={file.path} />
      </div>
      {expanded && <div className="ml-6 border-l-2 border-border py-1 pl-4">{children}</div>}
    </div>
  );
}

function EditDetail({ record }: Readonly<{ record: FileEditRecord }>) {
  const oldText = record.old ?? '';
  const nextText = record.next ?? record.content ?? '';
  const rows: DiffRow[] = useMemo(() => lineDiff(oldText, nextText), [oldText, nextText]);
  if (!oldText && !nextText) return null;
  let oldNum = 1, newNum = 1;
  const numbered = rows.map((r) => ({ ...r, oldN: r.type === 'add' ? null : oldNum++, newN: r.type === 'remove' ? null : newNum++ }));
  return (
    <div className="mt-1 overflow-auto rounded border border-border font-mono text-xs leading-relaxed">
      <table className="w-full border-collapse">
        <tbody>
          {/* Same diff colors as MessageItem's DiffView (including dark-theme compensation), so the two diff tables stay consistent */}
          {numbered.map((r, i) => {
            const nonAddSignColor = r.type === 'remove' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground/20';
            const signColor = r.type === 'add' ? 'text-green-600 dark:text-green-400' : nonAddSignColor;
            const nonAddSign = r.type === 'remove' ? '−' : '';
            const signChar = r.type === 'add' ? '+' : nonAddSign;
            return (
            <tr key={i} className={cn(r.type === 'add' && 'bg-green-500/15 dark:bg-green-500/20', r.type === 'remove' && 'bg-red-500/15 dark:bg-red-500/20')}>
              <td className="w-10 select-none border-r border-border bg-muted/40 px-1 text-right tabular-nums text-muted-foreground/50 align-top">{r.oldN ?? ''}</td>
              <td className="w-10 select-none border-r border-border bg-muted/40 px-1 text-right tabular-nums text-muted-foreground/50 align-top">{r.newN ?? ''}</td>
              <td className={cn('w-5 select-none text-center font-bold align-top', signColor)}>{signChar}</td>
              <td className="whitespace-pre px-1.5 align-top">{r.text}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Empty state: centered icon + description (replaces a bare "None") */
function EmptyState({ icon: Icon, title, hint }: Readonly<{ icon: typeof FileEdit; title: string; hint?: string }>) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-muted-foreground">
      <Icon className="size-9 opacity-25" />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-xs opacity-70">{hint}</p>}
    </div>
  );
}

/** KPI tile: hairline-separated band row (poster style: large black number + uppercase label, no boxed frame) */
function KpiTile({ label, value, color, sub }: Readonly<{ label: string; value: string; color: string; sub?: string }>) {
  return (
    <div className="flex flex-col gap-1 border-l border-border py-1 pl-4 first:border-l-0 first:pl-0">
      <span className="text-micro font-semibold uppercase tracking-eyebrow text-muted-foreground">{label}</span>
      <span className="text-display font-black leading-none tabular-nums tracking-tight" style={{ color }}>{value}</span>
      <span className="min-h-[14px] text-micro text-muted-foreground">{sub ?? ''}</span>
    </div>
  );
}

export function StatsDialog({ detail }: Readonly<{ detail: SessionDetail }>) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>('overview');
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState('');
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStats(null); setError('');
    let cancelled = false;
    // Shared stats cache (version key = last_ts: with no new messages it hits cache, avoiding a repeat call to the heavy endpoint)
    fetchSessionStats(detail.id, detail.last_ts ?? '')
      .then((data) => { if (!cancelled) setStats(data); })
      .catch((e: unknown) => { if (!cancelled) setError(errMessage(e)); });
    return () => { cancelled = true; };
  }, [open, detail.id, detail.last_ts]);

  const pieData = useMemo(() => (stats?.tools ?? []).map((t, i) => ({ name: t.name, value: t.count, color: PIE_COLORS[i % PIE_COLORS.length] })), [stats?.tools]);
  const modified = useMemo(() => (stats?.files ?? []).filter((f) => !f.isNew).sort((a, b) => b.edits - a.edits), [stats?.files]);
  const created = useMemo(() => (stats?.files ?? []).filter((f) => f.isNew).sort((a, b) => b.edits - a.edits), [stats?.files]);
  const deleted = stats?.deleted ?? [];
  const totalToolCalls = useMemo(() => stats?.tools.reduce((s, t) => s + t.count, 0) ?? 0, [stats?.tools]);
  const totalEdits = useMemo(() => modified.reduce((s, f) => s + f.edits, 0), [modified]);
  const cost = useMemo(() => estimateCost(detail.model, detail.tokens_in, detail.tokens_out, detail.cache_creation), [detail.model, detail.tokens_in, detail.tokens_out, detail.cache_creation]);
  const duration = formatDuration(stats?.overview?.firstTs ?? detail.first_ts, stats?.overview?.lastTs ?? detail.last_ts);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Standard DialogTrigger: focus returns to the trigger button on close (a hand-rolled onClick bypasses Radix's FocusScope; in testing all three close methods dropped focus to body) */}
      <DialogTrigger asChild>
        <button type="button" className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-micro text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary/70 [&_svg]:size-3" title="Session statistics" aria-label="Open session statistics">
          <BarChart3 /> Statistics
        </button>
      </DialogTrigger>
      {open && (
        // Radix Dialog: focus trap / Escape / focus restoration on close are delegated to the primitive (the earlier hand-rolled modal lacked all three)
        <DialogContent
          title="Session statistics"
          chrome="bare"
          className="flex h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none p-0 shadow-2xl sm:h-[min(94vh,1000px)] sm:w-[min(1480px,97vw)] sm:max-w-[97vw] sm:rounded-xl"
        >
            {/* Masthead: eyebrow + title + mono meta band */}
            <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 sm:px-8">
              <div className="min-w-0">
                <div className="text-micro font-semibold uppercase tracking-[0.28em] text-primary">Session Statistics</div>
                <h2 className="mt-1 truncate text-xl font-bold tracking-tight sm:text-2xl">{detail.title ?? detail.id}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-micro text-muted-foreground">
                  <span>{stats?.overview?.msgCount?.toLocaleString() ?? '—'} messages</span>
                  {duration && <span>{duration}</span>}
                  <span>{detail.tokens_in.toLocaleString()} → {detail.tokens_out.toLocaleString()} tok</span>
                  <span>{formatCost(cost)}</span>
                  <span className="hidden truncate sm:inline">{detail.id.slice(0, 8)}</span>
                </div>
              </div>
              <button type="button" className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setOpen(false)} aria-label="Close"><X className="size-5" /></button>
            </div>
            {/* Tabs (right-aligned) */}
            <div className="flex shrink-0 justify-start gap-1 overflow-x-auto border-b border-border px-5 pt-2 sm:justify-end sm:px-8" role="tablist">
              {TABS.map((t) => {
                const Icon = t.icon;
                const createdOrDeleted = t.id === 'created' ? created.length : deleted.length;
                const editsOrRest = t.id === 'edits' ? modified.length : createdOrDeleted;
                const cnt = t.id === 'overview' ? totalToolCalls : editsOrRest;
                return (
                  <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
                    id={`stats-tab-${t.id}`} aria-controls={`stats-panel-${t.id}`}
                    className={cn('flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-t-md px-2.5 py-2 text-xs transition-colors sm:px-3 [&_svg]:size-3.5',
                      tab === t.id ? 'border-b-2 border-primary bg-accent/50 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}
                    onClick={() => { setTab(t.id); setExpandedFile(null); }}>
                    <Icon />{t.label}<span className="hidden tabular-nums text-micro opacity-70 sm:inline">{cnt}</span>
                  </button>
                );
              })}
            </div>
            {/* Content */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8">
              {error && <p className="text-sm text-destructive">{error}</p>}
              {!stats && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
              {stats && (
                <>
                  {tab === 'overview' && (
                    <div className="flex flex-col gap-8" role="tabpanel" id="stats-panel-overview" aria-labelledby="stats-tab-overview">
                      {/* KPI band: hairline dividers, large black numbers */}
                      {/* 8-per-row only at ≥1536px (2xl); at 1280 it's 4×2, so large token numbers don't crowd the right edge or overflow */}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-5 py-4 sm:grid-cols-4 2xl:grid-cols-8">
                        <KpiTile label="Tool uses" value={totalToolCalls.toLocaleString()} color={C.blue} />
                        <KpiTile label="Messages" value={stats.overview?.msgCount?.toLocaleString() ?? '—'} color={C.violet} />
                        <KpiTile label="Cost" value={formatCost(cost)} color={C.cyan} />
                        <KpiTile label="Files modified" value={`${modified.length}`} color={C.orange} sub={`${totalEdits} edits`} />
                        <KpiTile label="Files created" value={`${created.length}`} color={C.green} />
                        <KpiTile label="Files deleted" value={`${deleted.length}`} color={C.red} />
                        <KpiTile label="Input tokens" value={detail.tokens_in.toLocaleString()} color={C.amber} />
                        <KpiTile label="Output tokens" value={detail.tokens_out.toLocaleString()} color={C.magenta} />
                      </div>
                      <section>
                        <SectionHeader className="mb-3">Tool distribution</SectionHeader>
                        <PieSection data={pieData} total={totalToolCalls} />
                      </section>
                      {(stats.models?.length ?? 0) > 0 && <ModelRanking models={stats.models} />}
                    </div>
                  )}
                  {tab === 'edits' && (
                    <div className="flex flex-col gap-1" role="tabpanel" id="stats-panel-edits" aria-labelledby="stats-tab-edits">
                      {modified.length === 0 && (
                        <EmptyState icon={FileEdit} title="No existing files were modified in this session" hint="Files changed via Edit / MultiEdit appear here" />
                      )}
                      {modified.map((f) => (
                        <FileRow key={f.path} file={f} expanded={expandedFile === f.path}
                          onToggle={() => setExpandedFile(expandedFile === f.path ? null : f.path)}
                          icon={<FileEdit className="size-3.5 shrink-0 text-muted-foreground" />}
                          right={<span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold tabular-nums text-primary">{f.edits} edits</span>}>
                          <div className="mb-1 text-micro text-muted-foreground">{f.history.length} edits (oldest first)</div>
                          {f.history.map((r, i) => (
                            <div key={i} className="mb-2">
                              {/* Which edit this is (diff ordinal) — a round badge stands out more than a plain "N." in small type */}
                              <div className="mb-1 flex items-center gap-2">
                                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold tabular-nums text-primary">{i + 1}</span>
                                <span className="text-micro text-muted-foreground/70">{r.ts ? formatTimeOfDay(r.ts) : ''}</span>
                              </div>
                              <EditDetail record={r} />
                            </div>
                          ))}
                        </FileRow>
                      ))}
                    </div>
                  )}
                  {tab === 'created' && (
                    <div className="flex flex-col gap-1" role="tabpanel" id="stats-panel-created" aria-labelledby="stats-tab-created">
                      {created.length === 0 && (
                        <EmptyState icon={FilePlus} title="No files were created in this session" hint="Files created via Write appear here (with a first-version preview)" />
                      )}
                      {created.map((f) => (
                        <FileRow key={f.path} file={f} expanded={expandedFile === f.path}
                          onToggle={() => setExpandedFile(expandedFile === f.path ? null : f.path)}
                          icon={<FilePlus className="size-3.5 shrink-0 text-green-500" />}>
                          {f.content ? <CodeBlock code={f.content} filePath={f.path} /> : <p className="text-xs text-muted-foreground">No content preview</p>}
                        </FileRow>
                      ))}
                    </div>
                  )}
                  {tab === 'deleted' && (
                    <div className="flex flex-col gap-1" role="tabpanel" id="stats-panel-deleted" aria-labelledby="stats-tab-deleted">
                      {deleted.length === 0 && (
                        <EmptyState icon={Trash2} title="No file deletions detected" hint="Detected heuristically from Bash rm commands; approximate" />
                      )}
                      {deleted.map((d) => (
                        <div key={d.path} className="group/row -mx-2 flex items-center gap-0.5">
                          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60" title={d.path}>
                            <Trash2 className="size-3.5 shrink-0 text-destructive" />
                            <span className="max-w-[50%] shrink-0 truncate font-mono">{baseName(d.path)}</span>
                            <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground/60">{shortDir(d.path)}</span>
                          </div>
                          <CopyPathButton path={d.path} />
                        </div>
                      ))}
                      {deleted.length > 0 && <p className="mt-1 text-micro text-muted-foreground">※ Heuristic from Bash rm; approximate</p>}
                    </div>
                  )}
                </>
              )}
            </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
