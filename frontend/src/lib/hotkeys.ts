import { useEffect } from 'react';

/** Hotkey definitions (used to render the shortcuts help) */
export const KEYBINDINGS = [
  { key: 'j', desc: 'Next message' },
  { key: 'k', desc: 'Previous message' },
  { key: 'g', desc: 'Scroll to top' },
  { key: 'Shift+G', desc: 'Jump to latest' },
  { key: '/', desc: 'Focus search' },
  { key: '?', desc: 'Show shortcuts' },
] as const;

export interface HotkeyContext {
  /** Scroll to a message index (an index relative to the virtual list, not the absolute session index) */
  scrollToIndex: (index: number) => void;
  /** Relative index of the first visible message within the virtual list */
  firstVisibleIndex: number;
  /** Next stop for j/k: decided by Reader (skips hidden rows in focus mode); returns -1 when there is none */
  nextIndex: (from: number, dir: 1 | -1) => number;
  /** Jump to the top */
  goTop: () => void;
  /** Jump to the bottom */
  goBottom: () => void;
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** j/k move one message at a time, g/G jump to top/bottom (dispatched from onKeyDown, extracted to lower the function's complexity) */
function handleMovementKeys(e: KeyboardEvent, ctx: HotkeyContext, el: HTMLElement): void {
  if (e.key === 'j') {
    e.preventDefault();
    const next = ctx.nextIndex(ctx.firstVisibleIndex, 1);
    if (next >= 0) ctx.scrollToIndex(next);
  }
  if (e.key === 'k') {
    e.preventDefault();
    const prev = ctx.nextIndex(ctx.firstVisibleIndex, -1);
    if (prev >= 0) ctx.scrollToIndex(prev);
  }
  // g = jump to top, G or Shift+g = jump to bottom (e.key for Shift+g is 'G')
  if ((e.key === 'G' || (e.key === 'g' && e.shiftKey)) && !isEditable(el)) {
    e.preventDefault();
    ctx.goBottom();
  } else if (e.key === 'g' && !e.shiftKey && !isEditable(el)) {
    e.preventDefault();
    ctx.goTop();
  }
}

/** / = focus search, ? = toggle the shortcuts help (broadcast to the relevant components via global custom events) */
function handleActionKeys(e: KeyboardEvent, el: HTMLElement): void {
  if (e.key === '/' && !isEditable(el)) {
    e.preventDefault();
    globalThis.dispatchEvent(new CustomEvent('recensa:focus-search'));
  }
  if (e.key === '?' && !isEditable(el)) {
    e.preventDefault();
    globalThis.dispatchEvent(new CustomEvent('recensa:toggle-help'));
  }
}

/** Register the reader's keyboard shortcuts; ctx is passed via a ref to avoid a stale closure */
export function useHotkeys(ctxRef: { current: HotkeyContext | null }) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const ctx = ctxRef.current;
      if (!ctx) return;
      // don't intercept inside input/textarea (the user is typing)
      if (isEditable(el)) {
        if (e.key !== '/') return; // '/' is the exception: still focus search from within the conversation stream
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      handleMovementKeys(e, ctx, el);
      handleActionKeys(e, el);
    }
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [ctxRef]);
}
