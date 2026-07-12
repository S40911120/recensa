import { useEffect, useState } from 'react';

export type DrawerId = 'none' | 'list' | 'info';

/**
 * Mobile (< lg) off-canvas drawer state machine: only one drawer slides out at a time (list / info).
 * It auto-collapses on three events — crossing to desktop, a route change, and pressing Esc —
 * pulling those reset behaviors out of App into an independently testable unit (route is treated
 * purely as a change signal; its type is left to the caller).
 */
export function useOffCanvasDrawer(routeSignal: unknown, isDesktop: boolean) {
  const [drawer, setDrawer] = useState<DrawerId>('none');

  useEffect(() => { if (isDesktop) setDrawer('none'); }, [isDesktop]); // close the drawer when crossing to desktop
  useEffect(() => { setDrawer('none'); }, [routeSignal]);              // collapse when selecting a session / returning home
  useEffect(() => {
    if (drawer === 'none') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer('none'); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [drawer]);

  return { drawer, setDrawer };
}
