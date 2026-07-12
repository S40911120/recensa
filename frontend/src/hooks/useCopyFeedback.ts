import { useEffect, useRef, useState } from 'react';

/** Shared "copy to clipboard + brief check-mark feedback" logic, used by the copy buttons on
 *  message cards, the stats view, and the summary sid. A denied clipboard permission fails
 *  silently (the content can still be selected manually); the timer is cleared on unmount. */
export function useCopyFeedback(resetMs = 1200): { isCopied: boolean; copy: (text: string) => Promise<void> } {
  const [isCopied, setIsCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setIsCopied(false), resetMs);
    } catch {
      // clipboard permission denied → fail silently
    }
  }
  return { isCopied, copy };
}
