import { useCallback, useEffect, useState } from 'react';

/**
 * In-page focus mode (not the browser's fullscreen): while active, the outermost container
 * carries data-zen and CSS hides all surrounding chrome marked data-chrome (side panels, top bar,
 * breadcrumb, meta, tag row) in one place. Esc exits. State lives here so components never need to
 * know about the "zen" layout concept.
 */
export function useZenMode() {
  const [isZen, setIsZen] = useState(false);
  const toggle = useCallback(() => setIsZen((v) => !v), []);
  useEffect(() => {
    if (!isZen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsZen(false); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [isZen]);
  return { isZen, toggle };
}
