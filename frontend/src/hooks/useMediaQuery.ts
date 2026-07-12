import { useEffect, useState } from 'react';

/**
 * Reactive media-query match. Used to switch the layout between the desktop
 * three-pane grid and the mobile off-canvas drawers (breakpoint: lg / 1024px).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    globalThis.window !== undefined && typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia(query).matches
      : false
  );

  useEffect(() => {
    const mq = globalThis.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
