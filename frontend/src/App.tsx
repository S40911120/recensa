import { Gauge, PanelRight, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InfoPanel } from './components/session/InfoPanel';
import { Reader } from './components/session/Reader';
import { SessionList } from './components/session/SessionList';
import { HotkeyHelp } from './components/HotkeyHelp';
import { IndexBanner } from './components/IndexBanner';
import { Settings } from './components/Settings';
import { Button } from './components/ui/button';
import { MessageSkeleton, RecensaIcon } from './components/ui/loading';
import { listSessions, locateSpawnCall, type SpawnLocateTarget } from './services/api';
import { useBoundaries } from './hooks/useBoundaries';
import { useMediaQuery } from './hooks/useMediaQuery';
import { LIVE_MODE, type ReaderMode, type ReaderSnapshot } from './hooks/useMessages';
import { useOffCanvasDrawer } from './hooks/useOffCanvasDrawer';
import { useIndexStatus } from './hooks/useIndexStatus';
import { useSessionDetail } from './hooks/useSessionDetail';
import { EMPTY_FILTERS, type SessionFilters } from './hooks/useSessions';
import { useZenMode } from './hooks/useZenMode';
import { cn } from './lib/utils';

/**
 * Hash routing (discriminated union; adding a new view mode touches only two places: parseRoute + mode derivation):
 * - `#/session/<mainId>/<agentFilename>/…`: normal reading. A subagent's full id is `<mainId>:<agentFilename>`;
 *   the URL keeps only the filename segment and reassembles it from the first segment when parsing. Compatible with
 *   the old `>`-joined format (which gets encoded to %3E → decode the whole string first, then decide).
 * - `#/reconstructed/<id>`: reconstructed view (standalone tab)
 * - `#/segment/<id>/<k>`: compaction-segment view (standalone tab)
 */
type Route =
  | { kind: 'home' }
  | { kind: 'session'; trail: string[] }
  | { kind: 'reconstructed'; id: string }
  | { kind: 'segment'; id: string; k: number };

/** The currently open session id (session takes the end of the trail, reconstructed/segment take id, home is null) */
function currentId(route: Route): string | null {
  switch (route.kind) {
    case 'session':
      return route.trail.at(-1) ?? null;
    case 'home':
      return null;
    default:
      return route.id;
  }
}

/** Parse the part after `#/session/` into a trail; an empty segment returns [] (the caller turns it into home). Extracted to lower parseRoute's complexity */
function parseSessionTrail(rawSegment: string): string[] {
  let raw = rawSegment;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // malformed encoding sequence → continue with the raw string (worst case no session is found, the UI doesn't crash)
  }
  const segments = raw.includes('>') ? raw.split('>').filter(Boolean) : raw.split('/').filter(Boolean);
  if (segments.length === 0) return [];
  const root = segments[0];
  if (raw.includes('>')) return segments;
  return segments.map((s, i) => {
    if (i === 0) return s;
    return s.includes(':') ? s : `${root}:${s}`;
  });
}

function parseRoute(): Route {
  const h = globalThis.location.hash;
  const seg = /^#\/segment\/([^/]+)\/(\d+)$/.exec(h);
  if (seg) {
    try {
      return { kind: 'segment', id: decodeURIComponent(seg[1]), k: Number(seg[2]) };
    } catch {
      return { kind: 'home' };
    }
  }
  if (h.startsWith('#/reconstructed/')) {
    try {
      const id = decodeURIComponent(h.slice('#/reconstructed/'.length));
      return id ? { kind: 'reconstructed', id } : { kind: 'home' };
    } catch {
      return { kind: 'home' };
    }
  }
  if (h.startsWith('#/session/')) {
    const trail = parseSessionTrail(h.slice('#/session/'.length));
    return trail.length > 0 ? { kind: 'session', trail } : { kind: 'home' };
  }
  return { kind: 'home' };
}

function writeHash(trail: string[]): void {
  if (trail.length === 0) {
    globalThis.location.hash = '#/';
    return;
  }
  const segments = trail.map((id, i) => (i === 0 ? id : (id.split(':')[1] ?? id)));
  globalThis.location.hash = `#/session/${segments.join('/')}`;
}

const DEFAULT_FILTERS: SessionFilters = EMPTY_FILTERS;
// Desktop breakpoint: aligned with Tailwind's `lg` (1024px); the single source of truth on the JS side, change the breakpoint only here
const LG_QUERY = '(min-width: 1024px)';

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const indexStatus = useIndexStatus(); // app-level index status (top progress bar + WS)
  const [filters, setFilters] = useState<SessionFilters>(DEFAULT_FILTERS);
  // Startup source detection: the default is 'claude', but a fresh Codex-only machine (no Claude Code
  // history at all) would otherwise open on a permanently empty list. Check once on mount and fall back
  // to Codex only if Claude Code truly has zero sessions and Codex has at least one; a user who has
  // already switched sources by the time this resolves is left alone (checked via the functional update).
  useEffect(() => {
    let cancelled = false;
    listSessions({ source: 'claude', limit: 1 })
      .then((rows) => {
        if (cancelled || rows.length > 0) return;
        return listSessions({ source: 'codex', limit: 1 }).then((codexRows) => {
          if (cancelled || codexRows.length === 0) return;
          setFilters((f) => (f.source === 'claude' ? { ...f, source: 'codex' } : f));
        });
      })
      .catch(() => { /* on failure, keep the static 'claude' default */ });
    return () => { cancelled = true; };
  }, []);
  const [isInfoOpen, setIsInfoOpen] = useState(() => localStorage.getItem('recensa:info-panel') !== '0');
  const [listRefreshKey, setListRefreshKey] = useState(0);
  // The jump request carries a sessionId: applied only when the target session is the one currently open (avoids a stale mis-jump, replacing a clearing effect)
  const [jumpRequest, setJumpRequest] = useState<{ sessionId: string; index: number; nonce: number } | null>(null);
  useEffect(() => { localStorage.setItem('recensa:info-panel', isInfoOpen ? '1' : '0'); }, [isInfoOpen]);
  // Responsive layout: on desktop (≥ lg) the left column is always present and the right info column collapses
  // (isInfoOpen toggles expanded ↔ rail); on mobile (< lg) both sides use the mobileDrawer off-canvas (one slides
  // out at a time). Focus mode (zen) and the drawer's Escape/reset behaviors are each encapsulated in a hook; zen
  // relies on data-zen on the outermost element + CSS hiding data-chrome, not the browser's fullscreen.
  const isDesktop = useMediaQuery(LG_QUERY);
  const { drawer: mobileDrawer, setDrawer: setMobileDrawer } = useOffCanvasDrawer(route, isDesktop);
  const { isZen, toggle: toggleZen } = useZenMode();
  // Mobile drawer focus management: move focus into the drawer on open, restore it to the trigger button on close (together with inert below this forms a focus trap, completing the dialog semantics)
  const leftDrawerRef = useRef<HTMLElement | null>(null);
  const rightDrawerRef = useRef<HTMLElement | null>(null);
  const drawerReturnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (isDesktop) return; // desktop uses a persistent column, no drawer focus juggling
    if (mobileDrawer === 'list') leftDrawerRef.current?.focus();
    else if (mobileDrawer === 'info') rightDrawerRef.current?.focus();
    else drawerReturnRef.current?.focus();
  }, [mobileDrawer, isDesktop]);
  // Restore scroll position when leaving and returning to a session (clear the cache on a non-session switch)
  const scrollCache = useRef<Map<string, number>>(new Map());
  // Per-session snapshot of the loaded message window: no reload when navigating into a subagent / back and forth along the trail — resume from where we left off
  const readerSnapshotCache = useRef<Map<string, ReaderSnapshot>>(new Map());

  const trail = useMemo(() => (route.kind === 'session' ? route.trail : []), [route]);
  const current = currentId(route);
  const { detail, error: detailError, refresh: refreshDetail } = useSessionDetail(current);

  // Compaction-segment view: derive segment bounds from boundaries (the k-th segment = just after the previous compaction point up to the k-th compaction point)
  const segBoundaries = useBoundaries(route.kind === 'segment' ? route.id : null);
  const segmentMode = useMemo<ReaderMode | null>(() => {
    if (route.kind !== 'segment' || segBoundaries.status !== 'ready') return null;
    const { k } = route;
    const bounds = segBoundaries.boundaries;
    if (k < 1 || k > bounds.length) return null;
    const start = k === 1 ? 0 : bounds[k - 2].index + 1;
    return { type: 'segment', k, range: { start, end: bounds[k - 1].index } };
  }, [route, segBoundaries]);

  const mode: ReaderMode =
    route.kind === 'reconstructed' ? { type: 'reconstructed' } : (segmentMode ?? LIVE_MODE);

  // flags changed (pin/tag/title) → refresh both the right-column detail and the left list in step
  const handleFlagsChanged = useCallback(() => {
    refreshDetail();
    setListRefreshKey((n) => n + 1);
  }, [refreshDetail]);

  // on successful delete → return home + refresh the list
  const handleDeleted = useCallback(() => {
    writeHash([]);
    setListRefreshKey((n) => n + 1);
  }, []);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    globalThis.addEventListener('hashchange', onHashChange);
    return () => globalThis.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleSelect = useCallback((sessionId: string) => writeHash([sessionId]), []);
  const handleHome = useCallback(() => writeHash([]), []);
  const handleOpenSubagent = useCallback(
    (subagentSessionId: string) => writeHash([...trail, subagentSessionId]),
    [trail]
  );
  const handleNavigate = useCallback((trailIndex: number) => writeHash(trail.slice(0, trailIndex + 1)), [trail]);

  // Single entry point for jump requests (a nonce makes Reader re-trigger every time)
  const jumpTo = useCallback((sessionId: string, index: number) => {
    setJumpRequest({ sessionId, index, nonce: Date.now() });
  }, []);

  // Search-hit jump: open the target session (trail) + jump to that index
  const handleOpenHit = useCallback(
    (hitTrail: string[], index: number) => {
      writeHash(hitTrail);
      const last = hitTrail.at(-1);
      if (last !== undefined) jumpTo(last, index);
    },
    [jumpTo]
  );

  // Locate a subagent's call site: find the index of the message that "emitted this spawn" and jump to it.
  // If the spawner ≠ the current session → open that spawner first (append to the trail), then jump.
  const handleLocateSpawn = useCallback(
    async (spawnerId: string, target: SpawnLocateTarget) => {
      let index = -1;
      try {
        index = await locateSpawnCall(spawnerId, target);
      } catch (e) {
        console.error('[locate-spawn] failed', e); // don't silence a genuine error (no-silent-failure)
        return;
      }
      if (index < 0) return; // 404: file changed, not found → silently don't jump
      if (spawnerId !== current) writeHash([...trail, spawnerId]);
      jumpTo(spawnerId, index);
    },
    [current, trail, jumpTo]
  );

  // tool_result → tool_use jump (the recensa:locate-tool event, dispatched by BlockView)
  useEffect(() => {
    async function onLocate(e: Event) {
      const toolUseId = (e as CustomEvent).detail as string;
      if (!toolUseId || !current) return;
      try {
        const index = await locateSpawnCall(current, { toolUseId });
        if (index >= 0) jumpTo(current, index);
      } catch (e) { console.error('[locate-tool] failed', e); }
    }
    globalThis.addEventListener('recensa:locate-tool', onLocate);
    return () => globalThis.removeEventListener('recensa:locate-tool', onLocate);
  }, [current, jumpTo]);

  // Segment view, three states: boundaries loading / boundaries invalid (k out of range or load failed) / ready
  const segmentPending = route.kind === 'segment' && segBoundaries.status === 'loading';
  const segmentInvalid =
    route.kind === 'segment' && (segBoundaries.status === 'error' || (segBoundaries.status === 'ready' && !segmentMode));
  const readerReady = current && !detailError && detail && !segmentPending && !segmentInvalid;

  // Each layout region is extracted into a render helper so App's body only handles skeleton and state, lowering the cognitive complexity of a single function (behavior and JSX unchanged)
  const renderMobileHeader = () => (
    // Mobile top bar — off-canvas drawer triggers (< lg only); data-chrome → hidden by CSS in zen mode
    <header data-chrome className="flex shrink-0 items-center gap-1 border-b border-border bg-card/60 px-2 py-1.5 lg:hidden">
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => { drawerReturnRef.current = e.currentTarget; setMobileDrawer((d) => (d === 'list' ? 'none' : 'list')); }}
        aria-label="Toggle session list"
        aria-expanded={mobileDrawer === 'list'}
      >
        <Search />
      </Button>
      <button type="button" className="flex min-w-0 flex-1 items-center justify-center gap-1.5" aria-label="Back to home" onClick={handleHome}>
        <RecensaIcon className="size-6" />
        <span className="truncate font-display text-base font-extrabold tracking-tight">Recensa</span>
      </button>
      {current && route.kind === 'session' ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => { drawerReturnRef.current = e.currentTarget; setMobileDrawer((d) => (d === 'info' ? 'none' : 'info')); }}
          aria-label="Toggle info panel"
          aria-expanded={mobileDrawer === 'info'}
        >
          <Gauge />
        </Button>
      ) : (
        <span className="size-9 shrink-0" aria-hidden />
      )}
    </header>
  );

  // LEFT — session list: mobile off-canvas drawer (space-driven), desktop fixed column always visible
  const renderLeftAside = () => (
    <aside
      ref={leftDrawerRef}
      data-chrome
      tabIndex={-1}
      role={isDesktop ? undefined : 'dialog'}
      aria-modal={!isDesktop && mobileDrawer === 'list' ? true : undefined}
      aria-label="Session list"
      inert={(!isDesktop && mobileDrawer !== 'list') || undefined}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border outline-none transition-transform duration-200',
        'fixed inset-y-0 left-0 z-40 w-[86vw] max-w-[320px] bg-card shadow-2xl',
        mobileDrawer === 'list' ? 'translate-x-0' : '-translate-x-full',
        'lg:static lg:z-auto lg:w-[320px] lg:max-w-none lg:translate-x-0 lg:bg-card/50 lg:shadow-none'
      )}
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        <SessionList
          filters={filters}
          onFiltersChange={setFilters}
          selectedId={trail[0] ?? null}
          refreshKey={listRefreshKey}
          onSelect={handleSelect}
          onOpenHit={handleOpenHit}
          onHome={handleHome}
        />
      </div>
      <Settings />
    </aside>
  );

  // CENTER — reader
  const renderReaderColumn = () => {
    const segSuffix = mode.type === 'segment' ? `:${mode.k}` : '';
    return (
      <main id="reader-main" tabIndex={-1} inert={(!isDesktop && mobileDrawer !== 'none') || undefined} className="relative isolate min-h-0 min-w-0 flex-1 overflow-hidden">
        {!current && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <RecensaIcon className="size-16" />
            <h1 className="font-display text-3xl font-black tracking-tight text-foreground">Recensa</h1>
            <p className="text-sm">Pick a session to start reading, or search your past conversations by full text or session id</p>
          </div>
        )}
        {current && detailError && <p className="p-6 text-sm text-destructive">Failed to load: {detailError}</p>}
        {current && !detailError && segmentInvalid && (
          <p className="p-6 text-sm text-muted-foreground">No such compaction segment (index out of range, or boundaries failed to load)</p>
        )}
        {current && !detailError && !segmentInvalid && (!detail || segmentPending) && (
          <div className="p-4">
            <MessageSkeleton rows={6} />
          </div>
        )}
        {readerReady && (
          <Reader
            key={`${mode.type}:${current}${segSuffix}`}
            detail={detail}
            trail={trail}
            mode={mode}
            jumpRequest={jumpRequest?.sessionId === current ? jumpRequest : null}
            scrollCache={scrollCache}
            snapshotCache={readerSnapshotCache}
            onOpenSubagent={handleOpenSubagent}
            onNavigate={handleNavigate}
            onFlagsChanged={handleFlagsChanged}
          />
        )}
        {/* Focus mode tab — centered over the reader column only (absolute inside main → never overlaps or shows on the side panels) */}
        {current && (
          <button
            type="button"
            onClick={toggleZen}
            aria-label={isZen ? 'Exit focus mode' : 'Enter focus mode'}
            aria-pressed={isZen}
            className={cn(
              // fixed (relative to the viewport, not absolute relative to main which widens in zen) → no shift when toggling on/off or on resolution changes; still inside main's isolate stacking context, doesn't cover the side panels
              'fixed bottom-0 left-1/2 z-40 w-36 -translate-x-1/2 pb-0.5 pt-1.5 text-center text-[10px] font-semibold uppercase tracking-wide text-primary-foreground shadow-lg transition-colors',
              isZen ? 'bg-primary' : 'bg-primary/55 hover:bg-primary/85'
            )}
            style={{ clipPath: 'polygon(14% 0, 86% 0, 100% 100%, 0 100%)' }}
          >
            {isZen ? 'Focus On' : 'Focus Off'}
          </button>
        )}
      </main>
    );
  };

  // RIGHT — info panel: mobile off-canvas drawer / desktop column (collapsible)
  const renderRightAside = () => (
    <aside
      ref={rightDrawerRef}
      data-chrome
      tabIndex={-1}
      role={isDesktop ? undefined : 'dialog'}
      aria-modal={!isDesktop && mobileDrawer === 'info' ? true : undefined}
      aria-label="Session info"
      inert={(!isDesktop && mobileDrawer !== 'info') || undefined}
      className={cn(
        'relative flex min-h-0 flex-col overflow-hidden border-l border-border outline-none transition-transform duration-200 lg:transition-[width]',
        'fixed inset-y-0 right-0 z-40 w-[86vw] max-w-[360px] bg-card shadow-2xl',
        mobileDrawer === 'info' ? 'translate-x-0' : 'translate-x-full',
        'lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:bg-card/30 lg:shadow-none',
        isInfoOpen ? 'lg:w-[360px]' : 'lg:w-12'
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute left-1 top-1.5 z-10 hidden lg:inline-flex"
        onClick={() => setIsInfoOpen((v) => !v)}
        aria-label={isInfoOpen ? 'Collapse info panel' : 'Expand info panel'}
        aria-expanded={isInfoOpen}
      >
        <PanelRight />
      </Button>
      {(!isDesktop || isInfoOpen) && detail ? (
        <div id="info-panel" tabIndex={-1} className="panel-enter min-h-0 w-full flex-1 overflow-hidden pt-0 lg:pt-10">
          <InfoPanel
            detail={detail}
            onOpenSubagent={handleOpenSubagent}
            onOpenSession={handleSelect}
            onFlagsChanged={handleFlagsChanged}
            onDeleted={handleDeleted}
            onJumpToMessage={(index) => current && jumpTo(current, index)}
            onLocateSpawn={handleLocateSpawn}
          />
        </div>
      ) : (
        <div className="hidden h-full w-10 lg:block" />
      )}
    </aside>
  );

  return (
    <>
    {/* skip-link: keyboard-only users can jump straight to the center/right columns instead of tabbing through the entire left list */}
    <a
      href="#reader-main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:text-primary-foreground"
    >
      Skip to conversation
    </a>
    <a
      href="#info-panel"
      className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-11 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:text-primary-foreground"
    >
      Skip to info panel
    </a>
    <HotkeyHelp />
    <div data-zen={isZen || undefined} className="relative flex h-screen flex-col overflow-hidden">
      {/* Top index progress bar: shown while the backend is (re)indexing so background work stays visible throughout (disappears once indexing completes, takes no space) */}
      <IndexBanner status={indexStatus} />
      {renderMobileHeader()}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {mobileDrawer !== 'none' && (
          <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" aria-hidden onClick={() => setMobileDrawer('none')} />
        )}

        {renderLeftAside()}

        {renderReaderColumn()}

        {current && route.kind === 'session' && renderRightAside()}

      </div>
    </div>
    </>
  );
}
