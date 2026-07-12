import { useCallback, useEffect, useRef, useState } from 'react';

import { errMessage } from '../lib/utils';
import { getMessages } from '../services/api';
import type { Message } from '../types';

const CHUNK_SIZE = 150;
/** How many to fetch per round when loading everything (uses the backend cap of 500 to reduce round-trips) */
const LOAD_ALL_CHUNK = 500;
/** How many lead-in context messages to keep before the target when jumping */
const JUMP_CONTEXT_LEAD = 30;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Shared no-op that swallows a promise rejection (avoids nesting an inner function inside a deep callback) */
const noop = (): undefined => undefined;

export type LoadState = 'loading' | 'error' | 'ready';

interface UseMessagesResult {
  messages: Message[];
  /** Absolute index of messages[0] within the whole session */
  startIndex: number;
  hasMore: boolean;
  hasOlder: boolean;
  total: number;
  state: LoadState;
  error: string;
  isLoadingMore: boolean;
  isLive: boolean;
  loadMore: () => Promise<void>;
  /** Load older messages; returns the number actually prepended (for scroll anchoring) */
  loadOlder: () => Promise<number>;
  /** Jump to a given absolute index; returns that message's relative position in the newly loaded page (-1 on failure) */
  goToIndex: (index: number) => Promise<number>;
  /** Load everything: pull chunk by chunk from the start to the end, accumulating all messages (total becomes exact). onProgress reports (loaded, total) */
  loadAll: (onProgress?: (loaded: number, total: number) => void) => Promise<void>;
  /** Whether loadAll is in progress */
  isLoadingAll: boolean;
}

/** uuid dedupe-merge — shared by all three load paths (loadMore / loadOlder / loadAll) to prevent key collisions when backend pages overlap */
function dedupeMerge(cur: Message[], incoming: Message[], position: 'append' | 'prepend'): Message[] {
  const seen = new Set(cur.map((m) => m.uuid));
  const fresh = incoming.filter((m) => !seen.has(m.uuid));
  if (fresh.length === 0) return cur;
  return position === 'append' ? [...cur, ...fresh] : [...fresh, ...cur];
}

export interface MessageRange {
  /** Absolute message index (inclusive) */
  start: number;
  /** Absolute message index (exclusive) */
  end: number;
}

/** Loaded-window snapshot: saved when leaving a session (opening a subagent / going back) so returning restores it directly without reloading */
export interface ReaderSnapshot {
  messages: Message[];
  startIndex: number;
  hasMore: boolean;
  hasOlder: boolean;
  total: number;
  exactTotal: boolean;
}

/** Snapshot-cache limit (approximate LRU: Map insertion order, oldest evicted when over capacity) */
const SNAPSHOT_CACHE_MAX = 12;

export function saveSnapshot(cache: Map<string, ReaderSnapshot>, id: string, snap: ReaderSnapshot): void {
  cache.delete(id); // re-insert to keep "most recently used last"
  cache.set(id, snap);
  if (cache.size > SNAPSHOT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Reading mode (a single enum that decides three things: endpoint / live tail / start position):
 *  live = a normal conversation (tail positioning + WS append); reconstructed = reconstructed view (static cache); segment = a compaction-segment range */
export type ReaderMode =
  | { type: 'live' }
  | { type: 'reconstructed' }
  | { type: 'segment'; k: number; range: MessageRange };

export const LIVE_MODE: ReaderMode = { type: 'live' };

export function useMessages(
  sessionId: string,
  mode: ReaderMode = LIVE_MODE,
  /** Loaded-window snapshot cache (live mode only): on a hit, restore directly and skip re-tailing */
  snapshotCache?: { current: Map<string, ReaderSnapshot> }
): UseMessagesResult {
  const isReconstructed = mode.type === 'reconstructed';
  const isLiveMode = mode.type === 'live';
  const [messages, setMessages] = useState<Message[]>([]);
  const [startIndex, setStartIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isLive, setIsLive] = useState(false);

  const lenRef = useRef(0);
  lenRef.current = messages.length;
  const startRef = useRef(0);
  startRef.current = startIndex;
  const stateRef = useRef<LoadState>('loading');
  stateRef.current = state;
  const inFlightRef = useRef(false);
  // After a full load, total is exact; live-tail appends keep it exact incrementally (otherwise the backend's approximation would overwrite it)
  const exactTotalRef = useRef(false);

  const rangeStart = mode.type === 'segment' ? mode.range.start : undefined;
  const rangeEnd = mode.type === 'segment' ? mode.range.end : undefined;

  /** In range mode, clamp the page to the range (hasMore/hasOlder are bounded by the range too) */
  const clampToRange = useCallback(
    (page: { messages: Message[]; from: number; hasMore: boolean; hasOlder: boolean }) => {
      if (rangeStart === undefined || rangeEnd === undefined) return page;
      const overflow = Math.max(0, page.from + page.messages.length - rangeEnd);
      const messages = overflow > 0 ? page.messages.slice(0, page.messages.length - overflow) : page.messages;
      return {
        ...page,
        messages,
        hasMore: page.from + messages.length < rangeEnd && page.hasMore,
        hasOlder: page.from > rangeStart,
      };
    },
    [rangeStart, rangeEnd]
  );

  const loadAt = useCallback(
    async (from: number | 'tail', signal?: AbortSignal) => {
      const raw = await getMessages(sessionId, from, CHUNK_SIZE, signal, isReconstructed);
      const page = clampToRange(raw);
      setMessages(page.messages);
      setStartIndex(page.from);
      setHasMore(page.hasMore);
      setHasOlder(page.hasOlder);
      setTotal(raw.total);
      exactTotalRef.current = false; // re-paged → total falls back to an approximation
      return page;
    },
    [sessionId, isReconstructed, clampToRange]
  );

  useEffect(() => {
    // Snapshot hit (live mode): restore the loaded window directly without reloading — resume from
    // where we left off; new messages are appended at the tail by appendFromEnd on WS onopen
    const snap = isLiveMode ? snapshotCache?.current.get(sessionId) : undefined;
    if (snap) {
      setMessages(snap.messages);
      setStartIndex(snap.startIndex);
      setHasMore(snap.hasMore);
      setHasOlder(snap.hasOlder);
      setTotal(snap.total);
      exactTotalRef.current = snap.exactTotal;
      setState('ready');
      return;
    }
    const controller = new AbortController();
    setState('loading');
    setMessages([]);
    loadAt(rangeStart ?? 'tail', controller.signal)
      .then(() => setState('ready'))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(errMessage(err));
        setState('error');
      });
    return () => controller.abort();
  }, [loadAt, rangeStart, isLiveMode, sessionId, snapshotCache]);

  // Save a snapshot when leaving the session (unmount / switch) — a ref captures the current state so cleanup doesn't depend on a state closure
  const snapshotRef = useRef<ReaderSnapshot | null>(null);
  snapshotRef.current = state === 'ready' && messages.length > 0
    ? { messages, startIndex, hasMore, hasOlder, total, exactTotal: exactTotalRef.current }
    : null;
  useEffect(() => {
    if (!isLiveMode || !snapshotCache) return;
    const cache = snapshotCache.current; // ref.current may already have changed by cleanup time — grab the current reference first
    return () => {
      if (snapshotRef.current) saveSnapshot(cache, sessionId, snapshotRef.current);
    };
  }, [sessionId, isLiveMode, snapshotCache]);

  const appendFromEnd = useCallback(async () => {
    const raw = await getMessages(sessionId, startRef.current + lenRef.current, CHUNK_SIZE, undefined, isReconstructed);
    const page = clampToRange({ ...raw, hasOlder: startRef.current > 0 });
    setHasMore(page.hasMore);
    // total: after a full load (exact), the effect below keeps total tracking messages.length; otherwise use the backend's approximation
    if (!exactTotalRef.current) setTotal(raw.total);
    if (page.messages.length > 0) setMessages((cur) => dedupeMerge(cur, page.messages, 'append'));
  }, [sessionId, isReconstructed, clampToRange]);

  // After a full load total is exact: as live-tail appends grow messages, total follows in step (not knocked back by the approximation)
  useEffect(() => {
    if (exactTotalRef.current) setTotal(messages.length);
  }, [messages.length]);

  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !hasMore) return;
    inFlightRef.current = true;
    setIsLoadingMore(true);
    try {
      await appendFromEnd();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      inFlightRef.current = false;
      setIsLoadingMore(false);
    }
  }, [appendFromEnd, hasMore]);

  const loadOlder = useCallback(async (): Promise<number> => {
    const floor = rangeStart ?? 0;
    if (inFlightRef.current || startRef.current <= floor) return 0;
    inFlightRef.current = true;
    try {
      const from = Math.max(floor, startRef.current - CHUNK_SIZE);
      const limit = startRef.current - from;
      const page = await getMessages(sessionId, from, limit, undefined, isReconstructed);
      let prepended = 0;
      setMessages((cur) => {
        const merged = dedupeMerge(cur, page.messages, 'prepend');
        prepended = merged.length - cur.length;
        return merged;
      });
      setStartIndex(from);
      setHasOlder(from > (rangeStart ?? 0));
      return prepended;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      return 0;
    } finally {
      inFlightRef.current = false;
    }
  }, [sessionId, isReconstructed, rangeStart]);

  const goToIndex = useCallback(
    async (index: number): Promise<number> => {
      if (inFlightRef.current) return -1;
      inFlightRef.current = true;
      try {
        const from = Math.max(0, index - JUMP_CONTEXT_LEAD);
        const page = await loadAt(from);
        if (page.messages.length === 0 && from > 0) {
          // Index is out of this session's range (e.g. a stale jump target) → fall back to the tail
          await loadAt('tail');
          return -1;
        }
        return index - page.from;
      } catch (err) {
        // Surface the real failure (network / 500) rather than silently collapsing it into the
        // out-of-range sentinel handled above — matches App.tsx handleLocateSpawn (lessons #16).
        console.error('[recensa] goToIndex failed:', err);
        return -1;
      } finally {
        inFlightRef.current = false;
      }
    },
    [loadAt]
  );

  const [isLoadingAll, setIsLoadingAll] = useState(false);
  // abort control for an in-progress loadAll: cancel on session switch / unmount so old-session data doesn't overwrite the new view
  const loadAllAbortRef = useRef<AbortController | null>(null);
  const loadAll = useCallback(
    async (onProgress?: (loaded: number, total: number) => void) => {
      if (inFlightRef.current) return;
      const controller = new AbortController();
      loadAllAbortRef.current = controller;
      inFlightRef.current = true;
      setIsLoadingAll(true);
      const floor = rangeStart ?? 0;
      // Pull chunk by chunk from floor to the end, accumulating all messages; returns null when
      // aborted midway (session switch). Extracted as an inner function so loadAll's body only
      // handles the state machine and error handling, lowering its complexity.
      const collectAll = async (): Promise<Message[] | null> => {
        let acc: Message[] = [];
        let from = floor;
        let rounds = 0;
        let maxRounds = 1000; // initial safety cap; tightened once the first round yields total; guards against a backend anomaly looping forever / OOM
        for (;;) {
          if (controller.signal.aborted) return null;
          const raw = await getMessages(sessionId, from, LOAD_ALL_CHUNK, controller.signal, isReconstructed);
          if (controller.signal.aborted) return null;
          const page = clampToRange(raw);
          acc = dedupeMerge(acc, page.messages, 'append');
          if (rounds === 0 && raw.total > 0) maxRounds = Math.ceil(raw.total / LOAD_ALL_CHUNK) + 5;
          onProgress?.(acc.length, Math.max(raw.total, 0));
          from += page.messages.length;
          rounds++;
          if (!page.hasMore || page.messages.length === 0 || rounds >= maxRounds) break;
        }
        return acc;
      };
      try {
        const acc = await collectAll();
        if (acc === null || controller.signal.aborted) return;
        setMessages(acc);
        setStartIndex(floor);
        setHasOlder(false);
        setHasMore(false);
        setTotal(rangeEnd === undefined ? acc.length : rangeEnd - floor); // total is exact after a full load
        exactTotalRef.current = rangeEnd === undefined; // live mode: mark total as exact
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') { /* normal on session switch */ }
        else { setError(err instanceof Error ? err.message : 'Failed to load all'); }
      } finally {
        if (loadAllAbortRef.current === controller) loadAllAbortRef.current = null;
        inFlightRef.current = false;
        setIsLoadingAll(false);
      }
    },
    [sessionId, isReconstructed, clampToRange, rangeStart, rangeEnd]
  );

  // Abort an in-progress loadAll on session switch / unmount (prevents old data overwriting the new view)
  useEffect(() => () => loadAllAbortRef.current?.abort(), [sessionId]);

  // live tail: session_updated → append at the tail; reconnect with exponential backoff on disconnect (reconstructed/segment views don't subscribe)
  useEffect(() => {
    if (!isLiveMode) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    function connect() {
      if (disposed) return;
      const proto = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${globalThis.location.host}/ws`);
      ws.onopen = () => {
        attempts = 0;
        setIsLive(true);
        // Tell the backend "I'm viewing this session" → pin it into the watched set, so however long it idles it keeps 700ms live-tail (not evicted by the 20s hot window)
        try { ws?.send(JSON.stringify({ type: 'watch', sessionId })); } catch { /* ignore */ }
        if (stateRef.current === 'ready') appendFromEnd().catch(noop);
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        if (stateRef.current !== 'ready') return;
        try {
          const payload = JSON.parse(ev.data) as { type: string; sessionId: string };
          if (payload.type === 'session_updated' && payload.sessionId === sessionId) {
            appendFromEnd().catch(noop);
          }
        } catch {
          // ignore non-JSON pushes
        }
      };
      ws.onclose = () => {
        setIsLive(false);
        if (disposed) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
        attempts++;
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    }

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [sessionId, appendFromEnd, isLiveMode]);

  return {
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
  };
}
