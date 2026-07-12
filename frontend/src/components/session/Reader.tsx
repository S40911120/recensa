import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronsUp,
  Download,
  Eye,
  EyeOff,
  Scissors,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatMonthDayTime } from '../../lib/format';
import { useHotkeys, type HotkeyContext } from '../../lib/hotkeys';
import { cn } from '../../lib/utils';

import { useBoundaries } from '../../hooks/useBoundaries';
import { LIVE_MODE, useMessages, type ReaderMode, type ReaderSnapshot } from '../../hooks/useMessages';
import { useReadingPosition } from '../../hooks/useReadingPosition';
import type { Message, SessionDetail } from '../../types';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { LoadingDots, MessageSkeleton } from '../ui/loading';
import { isHiddenInFocus, MessageItem, toolRefOf, type ToolRef } from './MessageItem';
import { ReaderBreadcrumb } from './ReaderBreadcrumb';
import { TitleFlags } from './TitleFlags';

interface ReaderProps {
  detail: SessionDetail;
  trail: string[];
  /** Reading mode: live (normal) / reconstructed (restored view) / segment (compaction-segment view) */
  mode?: ReaderMode;
  /** External jump request (from clicking a compaction node in InfoPanel; a nonce change triggers it) */
  jumpRequest?: { index: number; nonce: number } | null;
  onOpenSubagent: (sessionId: string) => void;
  onNavigate: (trailIndex: number) => void;
  /** Per-session scroll-position cache (restored on leave→return, without reloading) */
  scrollCache?: { current: Map<string, number> };
  /** Per-session loaded-window snapshot (so entering a subagent / returning doesn't reload messages; resumes from where you left off) */
  snapshotCache?: { current: Map<string, ReaderSnapshot> };
  /** Notify after title-area favorites (pin / custom title / tags) change (keeps the right column and left list in sync) */
  onFlagsChanged?: () => void;
}

// Estimate on the high side (a high percentile of the message-height distribution) rather than the average — per the recommended guidance: underestimating makes the initial position correct downward after measurement = jitter
const ESTIMATED_ROW_PX = 180;
// overscan covers one load chunk (CHUNK_SIZE=150): after go-top/go-bottom reloads into a single chunk, the whole window renders +
// gets measured, so smooth upward scrolling has no "newly-entered unmeasured items" → doesn't trigger an anchorTo:'end' re-anchor → no bounce-back.
// Cost: more rendered at once (~300 DOM), but the markdown LRU cache keeps repaint cheap and the load window is bounded (chunked).
const OVERSCAN_ROWS = 150;
// Above this message count, "load all" pulls everything into memory (a costly operation on very large
// sessions), so gate it behind an explicit confirmation prompt rather than running it silently.
const LOAD_ALL_CONFIRM_THRESHOLD = 10000;


/** Absolute-position list of the messages visible (the main conversation) in focusMode */
function collectFocusVisible(messages: Message[]): number[] {
  const arr: number[] = [];
  messages.forEach((m, i) => {
    if (!isHiddenInFocus(m)) arr.push(i);
  });
  return arr;
}

/** j/k navigation: from `from`, search in direction `dir` for the next jumpable position (focusVisibleIdx null → every message; otherwise jump only between visible rows) */
function pickNextIndex(from: number, dir: number, focusVisibleIdx: number[] | null, count: number): number {
  if (!focusVisibleIdx) {
    const n = from + dir;
    return n >= 0 && n < count ? n : -1;
  }
  if (dir === 1) {
    for (const i of focusVisibleIdx) if (i > from) return i;
    return -1;
  }
  for (let j = focusVisibleIdx.length - 1; j >= 0; j--) {
    if (focusVisibleIdx[j] < from) return focusVisibleIdx[j];
  }
  return -1;
}

/** Incrementally sync the cross-message toolUseId→tool name map (mutates m/scan in place, without recomputing everything) */
function syncToolNameMap(
  m: Map<string, ToolRef>,
  scan: { firstUuid: string | null; count: number },
  messages: Message[]
): void {
  const firstUuid = messages[0]?.uuid ?? null;
  if (scan.firstUuid !== firstUuid || messages.length < scan.count) {
    m.clear();
    scan.count = 0;
    scan.firstUuid = firstUuid;
  }
  for (let i = scan.count; i < messages.length; i++) {
    for (const b of messages[i].blocks) {
      if (b.kind === 'tool_use' && b.id) m.set(b.id, toolRefOf(b.name, b.input));
    }
  }
  scan.count = messages.length;
}

/** Load-all progress label (shows the loaded count when total is unknown) */
function loadAllLabelOf(progress: { loaded: number; total: number } | null): string {
  if (!progress) return 'Load all…';
  return progress.total > 0
    ? `Load all ${progress.loaded.toLocaleString()}/${progress.total.toLocaleString()}`
    : `Loaded ${progress.loaded.toLocaleString()} messages`;
}

/** Center column: breadcrumb + virtualized conversation stream (anchored to the end by default) + bidirectional loading + floating go-top / go-latest buttons */
export function Reader({ detail, trail, mode = LIVE_MODE, jumpRequest, onOpenSubagent, onNavigate, scrollCache, snapshotCache, onFlagsChanged }: Readonly<ReaderProps>) {
  const {
    messages,
    startIndex,
    hasMore,
    hasOlder,
    total,
    state,
    error,
    isLoadingMore,
    isLive,
    loadMore,
    loadOlder,
    goToIndex,
    loadAll,
    isLoadingAll,
  } = useMessages(detail.id, mode, snapshotCache);
  const [loadAllProgress, setLoadAllProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [focusMode, setFocusMode] = useState(false); // noise reduction: show only the main conversation, collapsing tool/thinking/system

  const [showLoadAllConfirm, setShowLoadAllConfirm] = useState(false);
  async function handleLoadAll() {
    if (total > LOAD_ALL_CONFIRM_THRESHOLD) { setShowLoadAllConfirm(true); return; }
    await doLoadAll();
  }
  async function doLoadAll() {
    setShowLoadAllConfirm(false);
    await loadAll((loaded, tot) => setLoadAllProgress({ loaded, total: tot }));
    setLoadAllProgress(null);
  }
  const parentRef = useRef<HTMLDivElement | null>(null);
  // Cross-message toolUseId→tool name map: maintained in the data layer (the virtual list only renders in-window items, so filling during render leaves blind spots).
  // Incremental update: each live-tail append scans only the new messages (a full recompute burned 160k Map.set calls per tick on a 10k-message session);
  // when the first uuid changes (prepend/window swap) or the length shrinks → rebuild. The Map mutates in place and the box identity stays stable, so MessageItem's memo isn't disturbed.
  const toolNameMapRef = useRef<{ current: Map<string, ToolRef> }>({ current: new Map() });
  const toolNameScanRef = useRef({ firstUuid: null as string | null, count: 0 });
  syncToolNameMap(toolNameMapRef.current.current, toolNameScanRef.current, messages);
  const didInitialScrollRef = useRef(false);
  // Compaction nodes: used as chips in the reconstructed view; in live mode, used to compute "% of this compaction block loaded" (not needed in segment view)
  const { boundaries } = useBoundaries(mode.type === 'segment' ? null : detail.id, mode.type === 'reconstructed');

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: OVERSCAN_ROWS,
    getItemKey: (i) => messages[i]?.uuid ?? i,
    // End-anchor: when prepending older messages, use the end as a stable anchor and auto-preserve position (replaces manual scrollTop delta compensation;
    //   the recommended chat pattern; core ≥ 3.16.1 fixed the prepend one-frame jump)
    anchorTo: 'end',
    // On new-message append, follow to the bottom only if the user was already at the bottom (live tail)
    followOnAppend: true,
  });
  const virtualItems = virtualizer.getVirtualItems();

  const scrollToEnd = useCallback(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  // Restore scroll position when returning to a session (no reload, no jump to bottom)
  const restoreRef = useRef(false);
  useEffect(() => {
    if (state === 'ready' && !didInitialScrollRef.current && messages.length > 0) {
      didInitialScrollRef.current = true;
      const cached = scrollCache?.current.get(detail.id);
      // Restore even 0 (scrolled to top) — when the snapshot hits, the message window matches how it was left, so the offset can be positioned exactly
      if (cached != null && (cached > 0 || snapshotCache?.current.has(detail.id))) {
        restoreRef.current = true;
        virtualizer.scrollToOffset(cached, { align: 'start' });
      } else if (mode.type !== 'segment') {
        scrollToEnd();
      }
    }
  }, [state, messages.length, scrollToEnd, mode.type, detail.id, scrollCache, snapshotCache, virtualizer]);

  // Save scroll position when leaving a session
  useEffect(() => () => {
    if (scrollCache && didInitialScrollRef.current) {
      const offset = virtualizer.scrollOffset ?? 0;
      scrollCache.current.set(detail.id, offset); // save even 0 (scrolled to top)
    }
  }, [detail.id, scrollCache, virtualizer]);

  // Scrolled to the loaded end → keep loading (downward paging beyond live tail)
  const lastRenderedIndex = virtualItems.at(-1)?.index ?? -1;
  useEffect(() => {
    if (didInitialScrollRef.current && lastRenderedIndex >= messages.length - 1 && hasMore) void loadMore();
  }, [lastRenderedIndex, messages.length, hasMore, loadMore]);

  // Load earlier: anchorTo:'end' auto-preserves position, so just prepend the data — no scrollTop compensation needed
  async function handleLoadOlder() {
    await loadOlder();
  }

  const [flashIndex, setFlashIndex] = useState<number | null>(null); // briefly highlight the target message after a jump (call site)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const jumpTo = useCallback(
    async (index: number) => {
      const rel = await goToIndex(index);
      if (rel >= 0) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(rel, { align: 'center' });
          requestAnimationFrame(() => virtualizer.scrollToIndex(rel, { align: 'center' }));
        });
        // Highlight using rel, the position relative to the load window (the list's vi.index is relative). An earlier effect wrongly used the absolute index →
        // when a large session's load window has startIndex>0, vi.index never equals the absolute index and the highlight never appeared (the root cause of it "still not working").
        setFlashIndex(rel);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = globalThis.setTimeout(() => setFlashIndex(null), 2000);
      }
    },
    [goToIndex, virtualizer]
  );

  // External jump request (clicking an item in the compaction-node list)
  const lastJumpNonceRef = useRef(0);
  useEffect(() => {
    if (jumpRequest && jumpRequest.nonce !== lastJumpNonceRef.current && state === 'ready') {
      lastJumpNonceRef.current = jumpRequest.nonce;
      void jumpTo(jumpRequest.index); // the highlight is set inside jumpTo using the relative rel (see above)
    }
  }, [jumpRequest, state, jumpTo]);
  // Clear the flash timer on unmount: switching sessions within 2s of a jump unmounts Reader (via key), avoiding a dangling timer calling setState on an unmounted component
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);

  // Smooth-scroll only within loaded content, without reloading: up = top of the load window (where the "Load earlier" button is), down = end of the load window.
  // No reload → no loss of loaded data, no jump to the absolute head/tail, no anchorTo bounce-back (content is already measured, overscan covers the whole window).
  function handleGoTop() {
    virtualizer.scrollToIndex(0, { align: 'start', behavior: 'smooth' });
  }

  function handleGoBottom() {
    virtualizer.scrollToIndex(Math.max(0, messages.length - 1), { align: 'end', behavior: 'smooth' });
  }

  // In focusMode, j/k jump only between visible (main-conversation) messages, not sticking on 0-height hidden rows
  const focusVisibleIdx = useMemo(() => (focusMode ? collectFocusVisible(messages) : null), [focusMode, messages]);

  // Hotkey ctx (a ref keeps the latest value without triggering a re-render)
  const hotkeyCtxRef = useRef<HotkeyContext | null>(null);
  hotkeyCtxRef.current = {
    scrollToIndex: (i) => virtualizer.scrollToIndex(i, { align: 'start', behavior: 'smooth' }),
    // Use the true top-of-viewport item (same algorithm as the position display), excluding the overscan top-edge offset
    firstVisibleIndex: (virtualItems.find((vi) => vi.start + vi.size > (virtualizer.scrollOffset ?? 0)) ?? virtualItems[0])?.index ?? 0,
    nextIndex: (from, dir) => pickNextIndex(from, dir, focusVisibleIdx, messages.length),
    goTop: handleGoTop,
    goBottom: handleGoBottom,
  };
  useHotkeys(hotkeyCtxRef);

  const title = detail.flags?.custom_title ?? detail.title ?? detail.id;

  // Reading-position indicator (live mode, updates on scroll): absolute position of the top visible message / total.
  // Use scrollOffset to find the true top-of-viewport item (excluding the overscan top edge, otherwise it's off by one overscan amount).
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  // Fallback to the last item (not the overscan top item), otherwise under extreme scrolling viewportTopAbs would be too small and point the wrong way
  const topVisible = virtualItems.find((vi) => vi.start + vi.size > scrollOffset) ?? virtualItems.at(-1);
  // Special-case 0%/100% at the very top/bottom (the top-item semantics only reach ~95% at the very bottom, but the "reading position" label should reach 100% at the end)
  const clientH = parentRef.current?.clientHeight ?? 0;
  const totalSize = virtualizer.getTotalSize();
  const { positionPct, segmentPct } = useReadingPosition({
    isLive: mode.type === 'live',
    total,
    startIndex,
    loadedCount: messages.length,
    topVisibleRelIndex: topVisible?.index ?? 0,
    atTop: scrollOffset <= 2,
    atBottom: totalSize > 0 && scrollOffset + clientH >= totalSize - 4,
    boundaries,
  });

  const loadMoreTotalSuffix = total ? ` / ~${total}` : '';
  const loadedCountLabel = `Loaded ${messages.length}${loadMoreTotalSuffix}`;
  const loadAllLabel = loadAllLabelOf(loadAllProgress);

  return (
    <div className="relative flex h-full flex-col">
      <div data-chrome className="contents"><ReaderBreadcrumb detail={detail} trail={trail} mode={mode} isLive={isLive} isReady={state === 'ready'} onNavigate={onNavigate} /></div>
      <header className="border-b border-border px-4 py-1.5">
        <div className="flex items-start gap-2">
          {mode.type === 'live' && detail.kind === 'main' ? (
            // Title-area favorites row (editor convention): editable title + pin + tags (flags exist only on the main session)
            <TitleFlags key={detail.id} detail={detail} onChanged={onFlagsChanged} />
          ) : (
            <h2 className="min-w-0 flex-1 truncate text-title font-semibold" title={title}>
              {title}
            </h2>
          )}
          <button
            type="button"
            className={cn(
              'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-micro transition-colors [&_svg]:size-3',
              focusMode
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            title={focusMode ? 'Show full conversation (with tool use and thinking)' : 'Main conversation only (collapse tools and noise)'}
            aria-pressed={focusMode}
            onClick={() => setFocusMode((v) => !v)}
          >
            {focusMode ? <Eye /> : <EyeOff />}
            Main
          </button>
        </div>
        {positionPct !== null && (
          <div
            data-chrome
            className="mt-1 flex flex-wrap items-center gap-x-2 text-micro text-muted-foreground"
            title="Your current reading position as a share of the whole conversation / current compaction segment (updates as you scroll; total is approximate)"
          >
            <span>
              Read position <span className="font-mono tabular-nums">{positionPct}%</span>
            </span>
            {segmentPct !== null && (
              <span>
                · This compaction segment <span className="font-mono tabular-nums">{segmentPct}%</span>
              </span>
            )}
            <span className="opacity-60">
              ({total.toLocaleString()} messages{hasOlder || hasMore ? ' · partially loaded' : ''})
            </span>
            {isLoadingAll ? (
              <LoadingDots label={loadAllLabel} className="text-micro text-primary" />
            ) : (
              (hasOlder || hasMore) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-1 px-1.5 text-micro text-primary hover:bg-primary/10 [&_svg]:size-3"
                  title="Load the entire conversation at once (may take a while for large sessions)"
                  onClick={() => void handleLoadAll()}
                >
                  <Download />
                  Load all
                </Button>
              )
            )}
          </div>
        )}
        {mode.type === 'reconstructed' && boundaries.length > 0 && (
          <div data-chrome className="mt-1.5 flex flex-wrap items-center gap-1 text-micro text-muted-foreground">
            <Scissors className="size-3" />
            Compaction points:
            {boundaries.map((b, i) => (
              <Button
                key={`${b.index}`}
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-micro text-muted-foreground hover:text-primary"
                onClick={() => void jumpTo(b.index)}
              >
                #{i + 1} {b.ts ? formatMonthDayTime(b.ts) : ''}
              </Button>
            ))}
          </div>
        )}
      </header>
      <div ref={parentRef} className="fade-in min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state === 'loading' && <MessageSkeleton rows={6} />}
        {state === 'error' && <p className="text-sm text-destructive">Failed to load: {error}</p>}
        {state === 'ready' && messages.length === 0 && (
          <p className="text-sm text-muted-foreground">This session has no messages to display</p>
        )}
        {state === 'ready' && hasOlder && (
          <div className="pb-2 text-center">
            <Button variant="secondary" size="sm" title="Load earlier messages" onClick={() => void handleLoadOlder()}>
              <ChevronsUp />
              Load earlier ({total ? `~${Math.max(total - messages.length, 0)} more` : 'more'} above)
            </Button>
          </div>
        )}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((vi) => {
            const m = messages[vi.index];
            if (!m) return null;
            // Noise-reduction hidden row: skip content and drop the wrapper padding so the virtualizer measures a true 0 height
            // (otherwise pb-2.5 leaves ~10px per hidden row, and a run of hidden rows accumulates into a large blank).
            const hiddenInFocus = focusMode && isHiddenInFocus(m);
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={cn('absolute left-0 top-0 w-full', !hiddenInFocus && 'pb-2.5')}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                {/* Apply the flash on the content layer (not the outer layer that carries pb-2.5) → the highlight box hugs the message body, matches hover, and doesn't spill into the row gap */}
                {!hiddenInFocus && (
                  <div className={cn(vi.index === flashIndex && 'session-flash')}>
                    <MessageItem message={m} onOpenSubagent={onOpenSubagent} focusMode={focusMode} toolNameMap={toolNameMapRef.current} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {state === 'ready' && hasMore && (
          <div className="py-3 text-center text-xs text-muted-foreground">
            {isLoadingMore ? (
              <LoadingDots label="Load more" className="justify-center text-xs" />
            ) : (
              loadedCountLabel
            )}
          </div>
        )}
      </div>

      {/* Load-all confirmation dialog */}
      <Dialog open={showLoadAllConfirm} onOpenChange={setShowLoadAllConfirm}>
        <DialogContent title="Load entire conversation">
          <p className="text-sm">This conversation has ~{total.toLocaleString()} messages; loading all will use more memory. Continue?</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowLoadAllConfirm(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void doLoadAll()}>Load all</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Floating navigation: go-top / go-bottom (compact pill; semi-transparent when idle so it doesn't block content, prominent only on hover) */}
      {state === 'ready' && messages.length > 0 && (
        <div className="absolute bottom-4 right-4 flex flex-col overflow-hidden rounded-full border border-border bg-background/70 opacity-50 shadow-lg backdrop-blur-md transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-primary [&_svg]:size-[15px]"
            aria-label="Scroll to top (session start)"
            title="Scroll to top"
            onClick={() => handleGoTop()}
          >
            <ArrowUpToLine />
          </button>
          <div className="mx-auto h-px w-4 bg-border" />
          <button
            type="button"
            className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-primary [&_svg]:size-[15px]"
            aria-label="Jump to latest message"
            title="Jump to latest"
            onClick={() => handleGoBottom()}
          >
            <ArrowDownToLine />
          </button>
        </div>
      )}
    </div>
  );
}
