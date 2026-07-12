import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { errMessage } from '../../lib/utils';
import { updateFlags } from '../../services/api';
import type { SessionFlags } from '../../types';

const MAX_NOTE_LEN = 2000;
const SAVED_FLASH_MS = 1800;

interface SessionNoteProps {
  sessionId: string;
  flags: SessionFlags | null;
  onChanged?: () => void;
}

/** Right-column note (long free text); pin/tags/custom title have moved to the center-column title area (TitleFlags). */
export function SessionNote({ sessionId, flags, onChanged }: Readonly<SessionNoteProps>) {
  const [note, setNote] = useState(flags?.note ?? '');
  const [saveError, setSaveError] = useState('');
  const [isSavedFlash, setIsSavedFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    []
  );

  // On blur, only save when the value actually changed (blurring without edits shouldn't trigger a refresh)
  async function commitNote() {
    if (note === (flags?.note ?? '')) return;
    try {
      setSaveError('');
      await updateFlags(sessionId, { note: note || null });
      onChanged?.();
      setIsSavedFlash(true); // auto-save succeeded → briefly show feedback (a silent save leaves the user unsure it was stored)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setIsSavedFlash(false), SAVED_FLASH_MS);
    } catch (err) {
      setSaveError(errMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <textarea
        className="h-16 w-full resize-none rounded-md border border-border bg-background px-2.5 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-primary/70"
        value={note}
        placeholder="Note…"
        maxLength={MAX_NOTE_LEN}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => void commitNote()}
      />
      {saveError && <span className="text-xs text-destructive">Save failed: {saveError}</span>}
      {isSavedFlash && !saveError && (
        <span className="fade-in inline-flex items-center gap-1 text-micro text-subagent [&_svg]:size-3">
          <Check />
          Saved
        </span>
      )}
    </div>
  );
}
