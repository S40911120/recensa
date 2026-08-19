import { useCallback, useEffect, useRef, useState } from 'react';

import { errMessage } from '../lib/utils';
import { listProjects, listSessions } from '../services/api';
import type { ProjectEntry, SessionSummary } from '../types';

const LIST_PAGE = 60;
const SEARCH_DEBOUNCE_MS = 250;

export interface SessionFilters {
  project: string;
  query: string;
  pinnedOnly: boolean;
  /** Advanced search fields (set via the dialog; empty string = disabled) */
  sid: string;
  model: string;
  since: string;
  until: string;
  tag: string;
  /** Which tool recorded the session ('claude' | 'codex'). Never empty: Claude Code and Codex sessions
   *  must never be listed/searched together, so a source is always selected (default 'claude'). */
  source: string;
}

export const EMPTY_FILTERS: SessionFilters = {
  project: '',
  query: '',
  pinnedOnly: false,
  sid: '',
  model: '',
  since: '',
  until: '',
  tag: '',
  source: 'claude',
};

function toParams(filters: SessionFilters, limit: number, offset: number) {
  return {
    project: filters.project || undefined,
    q: filters.query || undefined,
    sid: filters.sid || undefined,
    model: filters.model || undefined,
    since: filters.since || undefined,
    until: filters.until || undefined,
    tag: filters.tag || undefined,
    source: filters.source || undefined,
    pinned: filters.pinnedOnly,
    limit,
    offset,
  };
}

interface UseSessionsResult {
  sessions: SessionSummary[];
  projects: ProjectEntry[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string;
  hasMore: boolean;
  loadMore: () => Promise<void>;
}

/** Session list + project list + filtering/search (debounced) + paging (in-flight guard against
 *  double-fetch). A change to refreshKey re-fetches the first page, so external changes such as
 *  pin/tag are reflected immediately. */
export function useSessions(filters: SessionFilters, refreshKey = 0): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const offsetRef = useRef(0);
  offsetRef.current = sessions.length;
  const inFlightRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    listProjects(filters.source || undefined, controller.signal)
      .then(setProjects)
      .catch(() => setProjects([]));
    return () => controller.abort();
  }, [filters.source]);

  const filtersKey = JSON.stringify(filters);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError('');
    const t = setTimeout(() => {
      listSessions(toParams(filtersRef.current, LIST_PAGE, 0), controller.signal)
        .then((rows) => {
          if (controller.signal.aborted) return; // a superseded request may still resolve late — don't apply its rows
          setSessions(rows);
          setHasMore(rows.length === LIST_PAGE);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(errMessage(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
  }, [filtersKey, refreshKey]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return; // IntersectionObserver + button can both fire; guard against re-fetching the same offset
    inFlightRef.current = true;
    setIsLoadingMore(true);
    try {
      const rows = await listSessions(toParams(filtersRef.current, LIST_PAGE, offsetRef.current));
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...rows.filter((r) => !seen.has(r.id))];
      });
      setHasMore(rows.length === LIST_PAGE);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      inFlightRef.current = false;
      setIsLoadingMore(false);
    }
  }, []);

  return { sessions, projects, isLoading, isLoadingMore, error, hasMore, loadMore };
}
