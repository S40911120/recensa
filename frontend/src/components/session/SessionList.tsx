import { Bot, ChevronDown, CornerDownRight, FolderOpen, MessageSquareText, Search, Star, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useSessions, type SessionFilters } from '../../hooks/useSessions';
import { cn, errMessage } from '../../lib/utils';
import { locateMessage, searchAll } from '../../services/api';
import type { SearchHit } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { LoadingDots, RecensaIcon } from '../ui/loading';
import { AdvancedSearchDialog } from './AdvancedSearchDialog';

const HITS_LIMIT = 20;
const HITS_DEBOUNCE_MS = 300;
// When a query looks like a session id (uuid prefix) → pin id matches to the top (same test as the backend's sessionRepo.isSidLike; change one, change the other).
// Plain hex English words (beef/dead/cafe) shouldn't be swallowed by content search → additionally require a '-' or length ≥ 8
const SID_LIKE_RE = /^[0-9a-fA-F-]{4,}$/;
const isSidLike = (q: string): boolean => SID_LIKE_RE.test(q) && (q.includes('-') || q.length >= 8);

interface SessionListProps {
  filters: SessionFilters;
  onFiltersChange: (next: SessionFilters) => void;
  selectedId: string | null;
  refreshKey: number;
  onSelect: (sessionId: string) => void;
  /** Search-hit jump: open the trail and locate the message position */
  onOpenHit: (trail: string[], index: number) => void;
  onHome: () => void;
}

/** Open path for a matched session (a subagent hit must go through its parent first) */
function hitTrail(h: SearchHit): string[] {
  return h.kind === 'subagent' && h.parent_session ? [h.parent_session, h.session_id] : [h.session_id];
}

function decodeProject(encoded: string): string {
  return encoded.replace(/^([A-Z])--/, '$1:/').replaceAll('-', '/');
}

function formatWhen(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const isToday = d.toDateString() === new Date().toDateString();
  return isToday
    ? d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

/** A single hit row: on click, locate (uuid→position) then jump to that message */
function HitRow({ hit, onOpenHit }: Readonly<{ hit: SearchHit; onOpenHit: (trail: string[], index: number) => void }>) {
  const [locating, setLocating] = useState(false);

  async function jump() {
    if (locating) return;
    setLocating(true);
    try {
      const index = await locateMessage(hit.session_id, hit.uuid);
      onOpenHit(hitTrail(hit), index);
    } catch {
      // locate failed (message no longer exists) → at least open the session
      onOpenHit(hitTrail(hit), 0);
    } finally {
      setLocating(false);
    }
  }

  return (
    <li>
      <button
        type="button"
        className="group flex w-full cursor-pointer items-start gap-1.5 px-3 py-1.5 pl-5 text-left hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-50"
        disabled={locating}
        title="Jump to this match"
        onClick={() => void jump()}
      >
        <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground/50 group-hover:text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-foreground/90">{hit.snip}</span>
          <span className="text-micro text-muted-foreground">{formatWhen(hit.ts)}</span>
        </span>
      </button>
    </li>
  );
}

/** Message-level hits: grouped by session (multiple hits in one file form one group); each hit is clickable to jump to its position */
function SearchHits({ query, onOpenHit }: Readonly<{ query: string; onOpenHit: (trail: string[], index: number) => void }>) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState('');
  // starts true: SearchHits only mounts when there is a query, so a search always follows — this avoids
  // a one-frame flash of the empty-state before the first search kicks off.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setLoading(true);
    const t = setTimeout(() => {
      searchAll(query, HITS_LIMIT, controller.signal)
        .then((h) => {
          setHits(h);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(errMessage(err));
          setLoading(false);
        });
    }, HITS_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
  }, [query]);

  // Group by session while preserving hit order (relevance)
  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const arr = map.get(h.session_id);
      if (arr) arr.push(h);
      else map.set(h.session_id, [h]);
    }
    return [...map.values()];
  }, [hits]);

  if (error) return <section className="border-b border-border px-3 py-2 text-xs text-destructive">Message search failed: {error}</section>;
  if (loading && hits.length === 0) return null;
  // No content matches: render an explicit empty-state (not null) so a text query with neither a title
  // match nor a message match never leaves the panel blank.
  if (hits.length === 0) {
    return (
      <section className="border-b border-border px-3 py-3 text-xs text-muted-foreground">
        No messages match <span className="font-medium text-foreground">{query}</span>
      </section>
    );
  }

  return (
    <section className="border-b border-border bg-accent/20">
      <h3 className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3">
        <MessageSquareText />
        Content matches ({hits.length} hits · {groups.length} sessions)
      </h3>
      {groups.map((g) => {
        const head = g[0];
        return (
          <div key={head.session_id} className="pb-1">
            <div className="flex items-center gap-1.5 px-3 py-0.5 text-micro font-medium text-foreground/80">
              {head.kind === 'subagent' && <Bot className="size-3 shrink-0 text-subagent" />}
              <span className="truncate">{head.title ?? head.session_id.slice(0, 8)}</span>
              {g.length > 1 && <span className="shrink-0 text-muted-foreground">· {g.length} matches</span>}
            </div>
            <ul>
              {g.map((h) => (
                <HitRow key={h.uuid} hit={h} onOpenHit={onOpenHit} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export function SessionList({ filters, onFiltersChange, selectedId, refreshKey, onSelect, onOpenHit, onHome }: Readonly<SessionListProps>) {
  const { sessions, projects, isLoading, isLoadingMore, error, hasMore, loadMore } = useSessions(filters, refreshKey);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  // "/" key focuses the search box (Reader's keyboard shortcut dispatches the recensa:focus-search event)
  useEffect(() => {
    function onFocus() { searchInputRef.current?.focus(); }
    globalThis.addEventListener('recensa:focus-search', onFocus);
    return () => globalThis.removeEventListener('recensa:focus-search', onFocus);
  }, []);

  const advanced: Array<[keyof SessionFilters, string]> = [
    ['sid', 'sid'],
    ['model', 'model'],
    ['since', 'From'],
    ['until', 'To'],
    ['tag', 'tag'],
  ];
  const activeAdvanced = advanced.filter(([k]) => Boolean(filters[k]));

  const sessionRows = sessions.map((s) => (
    <li key={s.id}>
      <button
        type="button"
        className={cn(
          'block w-full cursor-pointer border-b border-border px-3 py-2 text-left transition-colors hover:bg-accent/60',
          s.id === selectedId && 'border-l-4 border-l-primary bg-accent'
        )}
        onClick={() => onSelect(s.id)}
      >
        <div className="flex items-baseline gap-1.5">
          {s.pinned === 1 && <Star className="size-3.5 shrink-0 fill-primary text-primary" />}
          <span className="truncate text-sm" title={s.custom_title ?? s.title ?? s.id}>{s.custom_title ?? s.title ?? s.id.slice(0, 8)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 overflow-hidden text-micro text-muted-foreground">
          <span className="shrink-0">{formatWhen(s.last_ts)}</span>
          <span className="truncate" title={decodeProject(s.project)}>
            {decodeProject(s.project)}
          </span>
          {s.subagent_count > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5">
              <Bot className="size-3 text-subagent" />
              {s.subagent_count}
            </span>
          )}
          {/* Tags aren't shown in the list: a session can carry many tags and a list row can't fit them (tags are viewed/edited in the right-column TitleFlags) */}
        </div>
      </button>
    </li>
  ));

  return (
    <div className="flex h-full flex-col">
      {/* Brand row: icon + wordmark link home, with the current listed-session count on the right */}
      <button
        type="button"
        className="group hidden w-full cursor-pointer items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-left transition-colors hover:bg-accent/50 lg:flex"
        aria-label="Back to home"
        onClick={onHome}
      >
        <RecensaIcon className="size-8" />
        <span className="font-display text-lg font-extrabold leading-none tracking-tight">Recensa</span>
        {sessions.length > 0 && (
          <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 font-mono text-micro font-medium tabular-nums text-primary">
            {sessions.length}
          </span>
        )}
      </button>

      {/* Search + filters: unified h-9 rounded-lg control sizing */}
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              className="h-9 rounded-lg pl-9 pr-8"
              value={filters.query}
              placeholder="Full-text / session id…"
              aria-label="Full-text or session id search"
              onChange={(e) => onFiltersChange({ ...filters, query: e.target.value })}
            />
            {filters.query && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Clear search"
                title="Clear"
                onClick={() => onFiltersChange({ ...filters, query: '' })}
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <AdvancedSearchDialog filters={filters} onApply={onFiltersChange} />
        </div>
        {activeAdvanced.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {activeAdvanced.map(([key, label]) => (
              <Badge key={key} variant="secondary">
                {label}: {String(filters[key])}
                <button
                  type="button"
                  className="cursor-pointer opacity-70 hover:opacity-100"
                  aria-label={`Clear ${label} filter`}
                  onClick={() => onFiltersChange({ ...filters, [key]: '' })}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <div className="relative min-w-0 flex-1">
            <FolderOpen className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <select
              className="h-9 w-full min-w-0 cursor-pointer appearance-none rounded-lg border border-border bg-background pl-8 pr-7 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary/70"
              value={filters.project}
              aria-label="Filter by project"
              onChange={(e) => onFiltersChange({ ...filters, project: e.target.value })}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.project} value={p.project}>
                  {decodeProject(p.project)} ({p.n})
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
          <button
            type="button"
            className={cn(
              'flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors [&_svg]:size-3.5',
              filters.pinnedOnly
                ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            aria-pressed={filters.pinnedOnly}
            title={filters.pinnedOnly ? 'Show all (currently pinned only)' : 'Pinned only'}
            onClick={() => onFiltersChange({ ...filters, pinnedOnly: !filters.pinnedOnly })}
          >
            <Star className={cn(filters.pinnedOnly && 'fill-primary')} />
            Pinned only
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {(() => {
          const q = filters.query.trim();
          // When a query looks like a session id (uuid prefix) → skip FTS content search (trigram 3-gram false positives); otherwise → content matches on top
          const looksLikeSid = isSidLike(q);
          const contentHits = q && !looksLikeSid ? <SearchHits query={q} onOpenHit={onOpenHit} /> : null;
          const listHeader =
            q && sessions.length > 0 ? (
              <h3 className="px-3 pt-2 pb-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                {looksLikeSid ? 'Session ID match' : 'Sessions (title / content match)'} ({sessions.length})
              </h3>
            ) : null;
          // stale-while-revalidate: show the skeleton only when the list is empty (initial load);
          // when refreshing an existing list (e.g. triggered by a favorites update), keep the old list and swap it seamlessly once data arrives — no flash, no jump.
          const showSkeleton = isLoading && sessions.length === 0;
          const sessionBlock = (
            <>
              {showSkeleton && (
                <div className="flex flex-col gap-2 p-3">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="border-b border-border pb-2">
                      <div className="skeleton mb-1.5 h-3.5 w-[70%]" />
                      <div className="skeleton h-2.5 w-[45%]" />
                    </div>
                  ))}
                </div>
              )}
              {error && <p className="p-4 text-sm text-destructive">Failed to load: {error}</p>}
              {!isLoading && !error && sessions.length === 0 && !contentHits && (
                <p className="p-4 text-sm text-muted-foreground">No matching sessions</p>
              )}
              {listHeader}
              <ul>{sessionRows}</ul>
              {hasMore && (
                <div ref={sentinelRef} className="p-3">
                  <Button variant="secondary" className="w-full" disabled={isLoadingMore} onClick={() => void loadMore()}>
                    {isLoadingMore ? <LoadingDots label="Load more" /> : 'Load more'}
                  </Button>
                </div>
              )}
            </>
          );
          return looksLikeSid ? (
            <>
              {sessionBlock}
              {contentHits}
            </>
          ) : (
            <>
              {contentHits}
              {sessionBlock}
            </>
          );
        })()}
      </div>
    </div>
  );
}
