import { useEffect, useState } from 'react';

import { KEYBINDINGS } from '../lib/hotkeys';
import { Dialog, DialogContent } from './ui/dialog';

/** Keyboard-shortcut help dialog (triggered by the ? key or the recensa:toggle-help event) */
export function HotkeyHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function toggle() { setOpen((v) => !v); }
    globalThis.addEventListener('recensa:toggle-help', toggle);
    return () => globalThis.removeEventListener('recensa:toggle-help', toggle);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Keyboard shortcuts">
        <div className="divide-y divide-border text-sm">
          {KEYBINDINGS.map((k) => (
            <div key={k.key} className="flex items-center justify-between py-1.5">
              <span className="text-muted-foreground">{k.desc}</span>
              <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{k.key}</kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
