import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useAsyncResource } from '../../hooks/useAsyncResource';
import { EMPTY_FILTERS, type SessionFilters } from '../../hooks/useSessions';
import { cn } from '../../lib/utils';
import { listTags } from '../../services/api';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '../ui/dialog';
import { Input } from '../ui/input';

interface AdvancedSearchDialogProps {
  filters: SessionFilters;
  onApply: (next: SessionFilters) => void;
}

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

/** Advanced search: sid prefix / model / date range / tags (tucked into a dialog, off the main layout) */
const NO_TAGS: string[] = [];

export function AdvancedSearchDialog({ filters, onApply }: Readonly<AdvancedSearchDialogProps>) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<SessionFilters>(filters);
  const { data: tags } = useAsyncResource((signal) => listTags(signal), [isOpen], {
    enabled: isOpen,
    initial: NO_TAGS,
  });

  useEffect(() => {
    if (!isOpen) return;
    setDraft(filters); // seed the draft from the current filters when the dialog opens
  }, [isOpen, filters]);

  const set = (patch: Partial<SessionFilters>) => setDraft((d) => ({ ...d, ...patch }));

  function handleApply() {
    onApply(draft);
    setIsOpen(false);
  }

  // If any advanced condition is active, highlight the trigger button so the user knows results are advance-filtered
  const hasActive = !!(filters.sid || filters.model || filters.since || filters.until);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Advanced search"
          title="Advanced search (session id / model / date)"
          className={cn(
            'flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border transition-colors [&_svg]:size-4',
            hasActive
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <SlidersHorizontal />
        </button>
      </DialogTrigger>
      <DialogContent title="Advanced search">
        <div className="flex flex-col gap-3">
          <Field label="Session ID (prefix ok)">
            <Input
              value={draft.sid}
              placeholder="041fb5e5…"
              className="font-mono"
              onChange={(e) => set({ sid: e.target.value.trim() })}
            />
          </Field>
          <Field label="Model (substring)">
            <Input value={draft.model} placeholder="fable / opus / sonnet…" onChange={(e) => set({ model: e.target.value.trim() })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From (activity on or after)">
              <Input type="date" value={draft.since} onChange={(e) => set({ since: e.target.value })} />
            </Field>
            <Field label="To (started on or before)">
              <Input type="date" value={draft.until} onChange={(e) => set({ until: e.target.value })} />
            </Field>
          </div>
          <Field label="Tag">
            <select
              className="h-8 w-full cursor-pointer rounded-md border border-border bg-background px-2 text-sm text-foreground"
              value={draft.tag}
              onChange={(e) => set({ tag: e.target.value })}
            >
              <option value="">Any</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <div className="mt-1 flex justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ ...EMPTY_FILTERS, project: draft.project, query: draft.query, pinnedOnly: draft.pinnedOnly, source: draft.source })}
            >
              Clear filters
            </Button>
            <div className="flex gap-2">
              <DialogClose asChild>
                <Button variant="outline" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button size="sm" onClick={handleApply}>
                Apply
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
