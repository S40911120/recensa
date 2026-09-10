import { useEffect, useState } from 'react';

import { appPath } from '../lib/basePath';

/** Backend index status (/api/index-status snapshot + WS index_progress/index_done). */
export interface IndexStatus {
  indexing: boolean;
  done: number;
  total: number;
  pct: number;
  phase: string;
  changed?: number;
  lastCompletedAt?: string | null;
  lastMs?: number | null;
}

const IDLE: IndexStatus = { indexing: false, done: 0, total: 0, pct: 100, phase: 'idle' };

/**
 * App-level index status: fetches the /api/index-status snapshot on mount, then opens a WS to
 * receive index_progress/index_done for live updates. Keeps "still indexing on first launch /
 * how many total" visible to the user throughout (background work is never a black box).
 * Reconnects with exponential backoff on disconnect.
 */
export function useIndexStatus(): IndexStatus {
  const [status, setStatus] = useState<IndexStatus>(IDLE);

  useEffect(() => {
    let cancelled = false;
    fetch(appPath('/api/index-status'))
      .then((r) => r.json())
      .then((s: IndexStatus) => { if (!cancelled) setStatus(s); })
      .catch(() => { /* DB not ready before the first index → stay idle */ });

    let ws: WebSocket | null = null;
    let retry = 0;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${globalThis.location.host}${appPath('/ws')}`);
      ws.onopen = () => { retry = 0; };
      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          const p = JSON.parse(ev.data);
          if (p.type === 'index_progress' || p.type === 'index_done') {
            setStatus({
              // Coerce the numeric fields at the parse boundary: a malformed push (numeric-as-string,
              // missing `done`) would otherwise reach IndexBanner's `.toLocaleString()` and throw in render
              // → ErrorBoundary → whole-app error screen. Mirrors the hardening in useMessages' WS handler.
              indexing: p.indexing,
              done: Number(p.done) || 0,
              total: Number(p.total) || 0,
              pct: Number(p.pct) || 0,
              phase: p.phase,
              changed: p.changed, lastCompletedAt: p.lastCompletedAt, lastMs: p.lastMs,
            });
          }
        } catch { /* ignore non-JSON */ }
      };
      ws.onclose = () => {
        if (closed) return;
        const delay = Math.min(1000 * 2 ** retry, 15000);
        retry += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };
    connect();

    return () => {
      cancelled = true;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, []);

  return status;
}
