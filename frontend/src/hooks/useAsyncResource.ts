import { useEffect, useState } from 'react';

export type AsyncStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Single-resource loading template (fetch + abort + three states), shared by useBoundaries and
 *  the skills / command / tag lists that previously duplicated near-identical useEffects.
 *  enabled=false returns idle and resets the data.
 *  Note: hooks with paging / debounce / stale-while-revalidate (useSessions, useMessages,
 *  useSessionDetail) have different semantics and deliberately do not use this template. */
export function useAsyncResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; initial: T }
): { data: T; status: AsyncStatus } {
  const { enabled = true, initial } = options;
  const [data, setData] = useState<T>(initial);
  const [status, setStatus] = useState<AsyncStatus>('idle');

  useEffect(() => {
    if (!enabled) {
      setData(initial);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    fetcher(controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return; // a superseded request may still resolve late — don't apply its data
        setData(d);
        setStatus('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setData(initial);
        setStatus('error');
      });
    return () => controller.abort();
    // The caller expresses the fetcher/initial dependencies via deps (an inline function gets a
    // new identity every render, so putting it in deps would loop forever).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { data, status };
}
