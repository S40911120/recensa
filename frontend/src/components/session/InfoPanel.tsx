import {
  Bot,
  Check,
  ChevronDown,
  Crosshair,
  Gauge,
  GitFork,
  History as HistoryIcon,
  Puzzle,
  Scissors,
  SquareArrowOutUpRight,
  SquareChevronRight,
  StickyNote,
  Trash2,
  Users,
} from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';

import { useAsyncResource } from '../../hooks/useAsyncResource';
import { useBoundaries } from '../../hooks/useBoundaries';
import { useCopyFeedback } from '../../hooks/useCopyFeedback';
import { formatDateTime, formatDuration, formatSize } from '../../lib/format';
import { estimateCost, formatCost } from '../../lib/pricing';
import { cn, errMessage } from '../../lib/utils';
import { deleteSession, getSkills, type SkillUsage, type SpawnLocateTarget } from '../../services/api';
import type { SessionDetail, SubagentSummary } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { CopyIconButton } from '../ui/copy-icon-button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { SectionHeader } from '../ui/section-header';
import { SessionNote } from './SessionNote';

const StatsDialog = lazy(() => import('./StatsDialog').then((m) => ({ default: m.StatsDialog })));


interface InfoPanelProps {
  detail: SessionDetail;
  onOpenSubagent: (sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onFlagsChanged: () => void;
  onDeleted: () => void;
  onJumpToMessage: (index: number) => void;
  /** Locate the "message that issued this spawn": spawnerId = the session that spawned the agent; target = toolUseId (precise) or agentName (fallback) */
  onLocateSpawn: (spawnerId: string, target: SpawnLocateTarget) => void;
}

/** Detect the viewing browser's OS. Recensa is a local self-hosted viewer, so browser OS ==
 *  the machine that will run `claude --resume`; picks the OS-default shell for the command. */
type OsKind = 'windows' | 'macos' | 'linux';

function detectOs(): OsKind {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows|Win32|Win64|WOW64/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  return 'linux';
}

/** Each OS gets its default-shell command + label. Windows PowerShell chains with `;`
 *  (PS 5.1/7 compatible; Set-Location handles drives); macOS zsh / Linux bash use POSIX `&&`. */
const OS_SHELL: Record<OsKind, string> = { windows: 'PowerShell', macos: 'zsh', linux: 'Bash' };

/** POSIX single-quote escaping (zsh/bash): wrap in single quotes, rewrite inner ' as '\'' */
const POSIX_ESCAPED_QUOTE = String.raw`'\''`;
const shPosix = (s: string) => `'${s.replaceAll("'", POSIX_ESCAPED_QUOTE)}'`;
/** PowerShell single-quote escaping: wrap in single quotes, rewrite inner ' as '' */
const shPwsh = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Shell-escape cwd/id before interpolation — when a malicious JSONL carries a cwd/id with metacharacters (quotes, ;, &&, $()),
 *  an unescaped copied command pasted into a terminal would break out into command injection (cwd is the session's recorded working directory and can be tainted). */
function buildResumeCmd(os: OsKind, cwd: string, id: string): string {
  return os === 'windows'
    ? `cd ${shPwsh(cwd)}; claude --resume ${shPwsh(id)}`
    : `cd ${shPosix(cwd)} && claude --resume ${shPosix(id)}`;
}

/** Continue this conversation: copy the cd + `claude --resume <id>` and paste it into a terminal to resume.
 *  claude --resume must run in the original cwd, so the cd is required; quoting the cwd guards against paths containing spaces.
 *  Emit a single command for the actual OS and label its shell (Windows → PowerShell / macOS → zsh / Linux → Bash). */
function ResumeButton({ cwd, id }: Readonly<{ cwd: string; id: string }>) {
  const { isCopied, copy } = useCopyFeedback();
  const os = detectOs();
  const shellLabel = OS_SHELL[os];
  const cmd = buildResumeCmd(os, cwd, id);
  return (
    <button
      type="button"
      className="mt-3 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary [&_svg]:size-3.5"
      title={cmd}
      aria-label={`Copy ${shellLabel} resume command for this conversation`}
      onClick={() => void copy(cmd)}
    >
      {isCopied ? (
        <><Check className="text-subagent" />Copied</>
      ) : (
        <><SquareChevronRight />Copy resume command <span className="text-muted-foreground/70">({shellLabel})</span></>
      )}
    </button>
  );
}

/** Overview mini-KPI (2×2 band, hairline dividers) */
function OverviewKpi({ label, value, sub, divider }: Readonly<{ label: string; value: string; sub?: string; divider?: boolean }>) {
  return (
    <div className={cn('flex flex-col gap-0.5 min-w-0', divider && 'border-l border-border pl-3')}>
      <span className="text-micro font-semibold uppercase tracking-eyebrow text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-black leading-tight tabular-nums">{value}</span>
      {sub && <span className="text-micro text-muted-foreground">{sub}</span>}
    </div>
  );
}

/** Compaction history: reconstruct the full conversation (opens a new tab) + a jump list of compaction points */
function CompactionSection({ detail, onJumpToMessage }: Readonly<{ detail: SessionDetail; onJumpToMessage: (index: number) => void }>) {
  const { boundaries, status } = useBoundaries(detail.compact_count > 0 ? detail.id : null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  function openTab(url: string) {
    const w = window.open(url, '_blank', 'noopener');
    setPopupBlocked(!w); // when a popup blocker intervenes, window.open returns null; failing silently would look like a broken button
  }

  return (
    <section className="border-t border-border pt-3">
      <SectionHeader icon={HistoryIcon}>Compaction history</SectionHeader>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        title="Flatten the full pre-compaction conversation and open it in a new tab"
        onClick={() => openTab(`/#/reconstructed/${detail.id}`)}
      >
        <HistoryIcon />
        Reconstruct full conversation
      </Button>
      {popupBlocked && (
        <p className="mt-1 text-micro text-destructive">Browser blocked the new tab; allow pop-ups for this site and retry</p>
      )}
      {status === 'error' && <p className="mt-1.5 text-micro text-destructive">Failed to load compaction points</p>}
      {boundaries.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5">
          {boundaries.map((b, i) => (
            <li key={b.index} className="flex items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground [&_svg]:size-3"
                title="Jump to this compaction point"
                onClick={() => onJumpToMessage(b.index)}
              >
                <Scissors />
                Compaction #{i + 1}
                <span className="ml-auto font-mono text-micro">
                  {formatDateTime(b.ts)}
                </span>
              </button>
              <button
                type="button"
                className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-primary [&_svg]:size-3"
                title="View the original text compacted at this point (new tab)"
                aria-label={`View the original text compacted at point ${i + 1}`}
                onClick={() => openTab(`/#/segment/${detail.id}/${i + 1}`)}
              >
                <SquareArrowOutUpRight />
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail.chain.ancestors.length > 0 && (
        <p className="mt-1.5 text-micro text-muted-foreground">This session has an upstream chain; the reconstructed view merges pre-compaction text across files.</p>
      )}
    </section>
  );
}

const NO_SKILLS: SkillUsage[] = [];

/** Skills used in this session (aggregated from Skill tool_use, lazy-loaded) */
function SkillsSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const { data: skills, status } = useAsyncResource(
    (signal) => getSkills(sessionId, signal),
    [sessionId],
    { initial: NO_SKILLS }
  );

  if (status === 'ready' && skills.length === 0) return null; // take up no space when no skills were used

  return (
    <section className="border-t border-border pt-3">
      <SectionHeader icon={Puzzle}>Skills used{status === 'ready' ? ` (${skills.length})` : ''}</SectionHeader>
      {status === 'loading' && <p className="text-micro text-muted-foreground">Loading…</p>}
      {status === 'error' && <p className="text-micro text-destructive">Failed to load skills</p>}
      {status === 'ready' && (
        <ul className="flex flex-wrap gap-1">
          {skills.map((s) => (
            <li key={s.name}>
              <Badge variant="secondary" className="font-mono" title={s.firstTs ? `First loaded ${formatDateTime(s.firstTs)}` : undefined}>
                {s.name}
                <span className="ml-1 opacity-70">×{s.count}</span>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Grouped teammate/subagent list: ≤10 listed directly, >10 collapsed by default (click the header to expand) */
const SUBAGENT_COLLAPSE_THRESHOLD = 10;

/** Same-name spawn-ordinal table: within each sibling level, the ordinal of each agent_name ordered by first_ts (1-based).
 *  Name-fallback locating uses it to pair "the k-th same-name spawn ↔ the k-th matching tool_use", instead of always jumping to the first */
function buildNameOrdinals(nodes: SubagentSummary[], map: Map<string, number> = new Map()): Map<string, number> {
  const counters = new Map<string, number>();
  for (const n of [...nodes].sort((a, b) => (a.first_ts ?? '').localeCompare(b.first_ts ?? ''))) {
    if (n.agent_name) {
      const k = (counters.get(n.agent_name) ?? 0) + 1;
      counters.set(n.agent_name, k);
      map.set(n.id, k);
    }
    if (n.children.length > 0) buildNameOrdinals(n.children, map);
  }
  return map;
}

/** A single subagent/teammate node: open button + locate-call-site button + recursive child nodes (nested indentation) */
function SubagentNode({
  node,
  fallbackSpawner,
  nameOrdinals,
  onOpenSubagent,
  onLocateSpawn,
}: Readonly<{
  node: SubagentSummary;
  /** When meta has no toolUseId the spawn edge is missing too → use the currently viewed session as the locate target */
  fallbackSpawner: string;
  /** Same-name spawn-ordinal table (produced by buildNameOrdinals, used for name-fallback locating) */
  nameOrdinals: Map<string, number>;
  onOpenSubagent: (id: string) => void;
  onLocateSpawn: (spawnerId: string, target: SpawnLocateTarget) => void;
}>) {
  const NodeIcon = node.is_teammate ? Users : Bot;
  // Locate target: toolUseId is precise; when it's absent (~1/5 of meta.json files omit it) → fall back to matching by "name + ordinal"
  const nameTarget: SpawnLocateTarget | null = node.agent_name
    ? { agentName: node.agent_name, nth: nameOrdinals.get(node.id) ?? 1 }
    : null;
  const locateTarget: SpawnLocateTarget | null = node.tool_use_id
    ? { toolUseId: node.tool_use_id }
    : nameTarget;
  const locateSpawner = node.spawner ?? fallbackSpawner;
  return (
    <li>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-auto min-w-0 flex-1 justify-start py-1 text-left"
          onClick={() => onOpenSubagent(node.id)}
        >
          <NodeIcon className="text-subagent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs">
              {node.agent_name ?? node.agent_desc ?? node.agent_type ?? node.id.split(':')[1] ?? node.id}
            </span>
            <span className="block truncate text-micro text-muted-foreground">
              {node.custom_agent_type ?? node.agent_type ?? '?'} · {node.msg_count} msgs
              {node.agent_model ? ` · ${node.agent_model}` : ''}
              {node.spawn_depth != null && node.spawn_depth > 0 ? ` · depth ${node.spawn_depth}` : ''}
            </span>
          </span>
        </Button>
        {locateTarget && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-primary [&_svg]:size-3.5"
            title={'toolUseId' in locateTarget ? 'Locate the message that spawned this agent' : 'Locate the message that spawned this agent (approximate match by name + order)'}
            aria-label="Locate the message that spawned this agent"
            onClick={() => onLocateSpawn(locateSpawner, locateTarget)}
          >
            <Crosshair />
          </Button>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-3 mt-1 flex flex-col gap-1 border-l border-border pl-2">
          {node.children.map((c) => (
            <SubagentNode key={c.id} node={c} fallbackSpawner={fallbackSpawner} nameOrdinals={nameOrdinals} onOpenSubagent={onOpenSubagent} onLocateSpawn={onLocateSpawn} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SubagentGroup({
  group,
  items,
  fallbackSpawner,
  nameOrdinals,
  onOpenSubagent,
  onLocateSpawn,
}: Readonly<{
  group: 'teammate' | 'subagent';
  items: SubagentSummary[];
  fallbackSpawner: string;
  nameOrdinals: Map<string, number>;
  onOpenSubagent: (id: string) => void;
  onLocateSpawn: (spawnerId: string, target: SpawnLocateTarget) => void;
}>) {
  const collapsible = items.length > SUBAGENT_COLLAPSE_THRESHOLD;
  const [open, setOpen] = useState(!collapsible);
  const GroupIcon = group === 'teammate' ? Users : Bot;
  const label = group === 'teammate' ? 'Teammates' : 'Subagents';

  const list = (
    <ul className="flex flex-col gap-1">
      {items.map((s) => (
        <SubagentNode key={s.id} node={s} fallbackSpawner={fallbackSpawner} nameOrdinals={nameOrdinals} onOpenSubagent={onOpenSubagent} onLocateSpawn={onLocateSpawn} />
      ))}
    </ul>
  );

  return (
    <section className="border-t border-border pt-3">
      {collapsible ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="mb-2 flex w-full cursor-pointer items-center gap-1.5 text-xs font-semibold uppercase tracking-eyebrow text-muted-foreground hover:text-foreground [&_svg]:size-3.5">
            <GroupIcon />
            {label} ({items.length})
            <ChevronDown className={cn('ml-auto size-3.5 transition-transform', open && 'rotate-180')} />
          </CollapsibleTrigger>
          <CollapsibleContent>{list}</CollapsibleContent>
        </Collapsible>
      ) : (
        <>
          <SectionHeader icon={GroupIcon}>{label} ({items.length})</SectionHeader>
          {list}
        </>
      )}
    </section>
  );
}

/** Danger zone: delete session (irreversible; chain members / pinned are rejected by the backend and disabled up front on the frontend) */
function DeleteSection({ detail, onDeleted }: Readonly<{ detail: SessionDetail; onDeleted: () => void }>) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  const isChained = detail.chain.ancestors.length > 0 || detail.chain.children.length > 0;
  const isPinned = (detail.flags?.pinned ?? 0) === 1;
  const pinnedReason = isPinned ? 'Pinned; unpin first' : '';
  const blockReason = isChained
    ? 'Part of a fork/resume chain (has upstream or branches); cannot delete'
    : pinnedReason;

  async function handleDelete() {
    setIsDeleting(true);
    setError('');
    try {
      await deleteSession(detail.id);
      setIsConfirmOpen(false);
      onDeleted();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section className="border-t border-border pt-3">
      {blockReason ? (
        <p className="text-xs text-muted-foreground">Cannot delete: {blockReason}</p>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setIsConfirmOpen(true)}
        >
          <Trash2 />
          Delete this session
        </Button>
      )}
      <Dialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <DialogContent title="Confirm delete (irreversible)">
          <p className="mb-1 text-sm">
            Permanently delete the original transcript file
            {detail.subagents.length > 0 ? ` and ${detail.subagents.length} subagent records` : ''}, index, and pin/tag marks:
          </p>
          <p className="mb-3 break-all font-mono text-xs text-muted-foreground">{detail.id}</p>
          {error && <p className="mb-2 text-xs text-destructive">Delete failed: {error}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm" disabled={isDeleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              className="bg-destructive text-white hover:bg-destructive/85"
              disabled={isDeleting}
              onClick={() => void handleDelete()}
            >
              {isDeleting ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

interface ChainRowNode {
  id: string;
  title: string | null;
  compact_count: number;
  missing?: boolean;
}

/** Timeline-style chain node: dot + title line + short-id subline (no per-level indentation, so it stays readable in a narrow column) */
function ChainRow({
  node,
  kind,
  onOpenSession,
}: Readonly<{
  node: ChainRowNode;
  kind: 'ancestor' | 'current' | 'child';
  onOpenSession: (id: string) => void;
}>) {
  const nonCurrentDot = kind === 'child' ? 'bg-subagent' : 'bg-muted-foreground';
  const dotClass = kind === 'current' ? 'bg-primary' : nonCurrentDot;
  const isCurrent = kind === 'current';
  const nonCurrentContent = node.missing ? (
    <span className="block truncate text-xs text-muted-foreground" title="Upstream session file no longer exists">
      (source no longer exists)
    </span>
  ) : (
    <button
      type="button"
      className="block w-full cursor-pointer truncate text-left text-xs text-foreground hover:text-primary hover:underline"
      title={node.title ?? node.id}
      onClick={() => onOpenSession(node.id)}
    >
      {node.title ?? '(untitled)'}
    </button>
  );
  return (
    <li className="relative pb-2 last:pb-0">
      <span className={`absolute -left-[17px] top-1.5 size-2 rounded-full ${dotClass}`} />
      {isCurrent ? (
        <span className="block truncate text-xs font-semibold text-foreground">{node.title}</span>
      ) : (
        nonCurrentContent
      )}
      <span className="mt-0.5 flex items-center gap-2 text-micro text-muted-foreground">
        <span className="font-mono">{node.id.slice(0, 8)}</span>
        {node.compact_count > 0 && (
          <Badge variant="muted" className="px-1 py-0 text-micro">
            Compacted ×{node.compact_count}
          </Badge>
        )}
        {kind === 'ancestor' && <span>Upstream</span>}
        {kind === 'child' && <span>Branch</span>}
      </span>
    </li>
  );
}

/** Right-column info panel: session overview + pin/note + subagents + delete */
export function InfoPanel({ detail, onOpenSubagent, onOpenSession, onFlagsChanged, onDeleted, onJumpToMessage, onLocateSpawn }: Readonly<InfoPanelProps>) {
  // Same-name spawn-ordinal table (used to pair name-fallback locating)
  const nameOrdinals = useMemo(() => buildNameOrdinals(detail.subagents), [detail.subagents]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <SectionHeader icon={Gauge} className="mb-0">Session overview</SectionHeader>
          <Suspense fallback={null}><StatsDialog detail={detail} /></Suspense>
        </div>
        {/* Mini KPI band: magnitude at a glance (details still in the dl below) */}
        <div className="mb-3 grid grid-cols-2 gap-y-3 border-y border-border py-2.5">
          <OverviewKpi label="Messages" value={detail.msg_count.toLocaleString()} sub={`${detail.user_prompts.toLocaleString()} prompts`} />
          <OverviewKpi label="Tool use" value={detail.tool_calls.toLocaleString()} divider />
          <OverviewKpi
            label="Est. cost"
            value={formatCost(estimateCost(detail.model, detail.tokens_in, detail.tokens_out, detail.cache_creation))}
          />
          <OverviewKpi label="Duration" value={formatDuration(detail.first_ts, detail.last_ts) ?? '—'} divider />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Project</dt>
          <dd className="break-all font-mono">{detail.cwd ?? detail.project}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd className="font-mono">
            {detail.model ?? '—'}
            {detail.models.length > 1 && (
              // Custom instant tooltip (the native title has a ~1s delay): shows immediately on hover; mobile has no hover → tabIndex lets a tap-focus reveal it too
              <button
                type="button"
                aria-label={`All models used: ${detail.models.join(', ')}`}
                className="group/models relative ml-1 inline-block cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left align-baseline font-sans font-normal text-muted-foreground underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                + {detail.models.length - 1} more models
                <span className="pointer-events-none absolute bottom-full left-0 z-20 mb-1 hidden w-max max-w-[280px] rounded-md border border-border bg-card px-2.5 py-1.5 text-left font-mono text-micro leading-relaxed text-foreground shadow-lg group-hover/models:block group-focus/models:block">
                  {detail.models.map((m) => (
                    <span key={m} className="block">{m}</span>
                  ))}
                </span>
              </button>
            )}
          </dd>
          <dt className="text-muted-foreground">Effort</dt>
          <dd className="font-mono">
            {detail.effort ?? '—'}
            {detail.efforts.length > 1 && (
              <span className="ml-1 font-sans text-muted-foreground">
                (also {detail.efforts.filter((e) => e !== detail.effort).join(', ')})
              </span>
            )}
          </dd>
          <dt className="self-start text-muted-foreground">tokens</dt>
          <dd>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono">
              <span className="text-muted-foreground">Output</span>
              <span className="text-right tabular-nums">{detail.tokens_out.toLocaleString()}</span>
              <span className="text-muted-foreground">Input</span>
              <span className="text-right tabular-nums">{detail.tokens_in.toLocaleString()}</span>
              <span className="text-muted-foreground">Cache read</span>
              <span className="text-right tabular-nums">{detail.cache_read.toLocaleString()}</span>
              {detail.cache_creation > 0 && (
                <>
                  <span className="text-muted-foreground">Cache creation</span>
                  <span className="text-right tabular-nums">{detail.cache_creation.toLocaleString()}</span>
                </>
              )}
            </div>
          </dd>
          {detail.git_branch && (
            <>
              <dt className="text-muted-foreground">Branch</dt>
              <dd className="font-mono">{detail.git_branch}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Size</dt>
          <dd>{formatSize(detail.size)}</dd>
          <dt className="text-muted-foreground">Time range</dt>
          <dd className="tabular-nums">
            {formatDateTime(detail.first_ts)}
            {' – '}
            {formatDateTime(detail.last_ts)}
          </dd>
          <dt className="text-muted-foreground">sid</dt>
          <dd className="flex items-start gap-1">
            <span className="min-w-0 break-all font-mono">{detail.id}</span>
            <CopyIconButton text={detail.id} label="Copy session id" className="p-0.5 [&_svg]:size-3" />
          </dd>
          <dt className="text-muted-foreground">Compaction</dt>
          <dd>
            {detail.compact_count > 0 ? (
              <Badge variant="default">Compacted ×{detail.compact_count}</Badge>
            ) : (
              <span className="text-muted-foreground">
                {detail.forked_from ? 'This file not compacted · upstream chain has compaction history' : 'Not compacted'}
              </span>
            )}
          </dd>
        </dl>
        {/* Continue this conversation: copy the resume command and paste it back into a terminal (main session with a cwd only; a subagent's composite id can't be resumed) */}
        {detail.kind === 'main' && detail.cwd && (
          <ResumeButton cwd={detail.cwd} id={detail.id} />
        )}
      </section>

      {(detail.compact_count > 0 || detail.chain.ancestors.length > 0) && (
        <CompactionSection detail={detail} onJumpToMessage={onJumpToMessage} />
      )}

      {(detail.chain.ancestors.length > 0 || detail.chain.children.length > 0) && (
        <section className="border-t border-border pt-3">
          <SectionHeader icon={GitFork}>Session chain</SectionHeader>
          <ol className="relative flex flex-col border-l border-border pl-3 [margin-left:5px]">
            {[...detail.chain.ancestors].reverse().map((n) => (
              <ChainRow key={n.id} node={n} kind="ancestor" onOpenSession={onOpenSession} />
            ))}
            <ChainRow
              node={{ id: detail.id, title: 'Current session', compact_count: detail.compact_count }}
              kind="current"
              onOpenSession={onOpenSession}
            />
            {detail.chain.children.map((n) => (
              <ChainRow key={n.id} node={n} kind="child" onOpenSession={onOpenSession} />
            ))}
          </ol>
        </section>
      )}

      {detail.kind === 'main' && (
        <section className="border-t border-border pt-3">
          <SectionHeader icon={StickyNote}>Note</SectionHeader>
          <SessionNote key={detail.id} sessionId={detail.id} flags={detail.flags} onChanged={onFlagsChanged} />
        </section>
      )}

      <SkillsSection sessionId={detail.id} />

      {(['teammate', 'subagent'] as const).map((group) => {
        const items = detail.subagents.filter((s) => s.is_teammate === (group === 'teammate'));
        if (items.length === 0) return null;
        return (
          <SubagentGroup
            key={group}
            group={group}
            items={items}
            fallbackSpawner={detail.id}
            nameOrdinals={nameOrdinals}
            onOpenSubagent={onOpenSubagent}
            onLocateSpawn={onLocateSpawn}
          />
        );
      })}

      {detail.kind === 'main' && <DeleteSection detail={detail} onDeleted={onDeleted} />}
    </div>
  );
}
