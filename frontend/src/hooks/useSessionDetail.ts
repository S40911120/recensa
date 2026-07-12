import { useCallback, useEffect, useRef, useState } from 'react';

import { errMessage } from '../lib/utils';
import { getSession } from '../services/api';
import type { SessionDetail } from '../types';

interface UseSessionDetailResult {
  detail: SessionDetail | null;
  error: string;
  refresh: () => void;
}

/** Session detail (the single fetch source at the App level, passed down to both Reader and InfoPanel) */
export function useSessionDetail(sessionId: string | null): UseSessionDetailResult {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const prevIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      prevIdRef.current = null;
      return;
    }
    const controller = new AbortController();
    setError('');
    // Clear the old detail only when switching sessions (to avoid a stale flash); on refresh
    // (nonce++ within the same session) keep the old detail until the new one arrives, otherwise
    // unmounting InfoPanel/FlagsBar loses the optimistic update (the bug where a newly added tag
    // was wiped).
    if (prevIdRef.current !== sessionId) {
      setDetail(null);
      prevIdRef.current = sessionId;
    }
    getSession(sessionId, controller.signal)
      .then(setDetail)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setError(errMessage(err));
      });
    return () => controller.abort();
  }, [sessionId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { detail, error, refresh };
}
