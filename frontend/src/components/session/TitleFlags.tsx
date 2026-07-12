import { Pencil, Star, Tag, X } from 'lucide-react';
import { useState } from 'react';

import { cn, errMessage } from '../../lib/utils';
import { updateFlags, type FlagsUpdate } from '../../services/api';
import type { SessionDetail } from '../../types';
import { Badge } from '../ui/badge';

// Input caps (pasting oversized values straight to the backend would bloat flags.db; kept in sync with the backend TITLE_MAX=160)
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const MAX_TITLE_LEN = 160;

interface TitleFlagsProps {
  detail: SessionDetail;
  onChanged?: () => void;
}

/** Title-area favorites row (editor convention): editable title (pencil appears on hover) + pin star + tag-chips row.
 *  The note (long free text) still lives in the right-column SessionNote. Callers remount per session via key={detail.id}. */
export function TitleFlags({ detail, onChanged }: Readonly<TitleFlagsProps>) {
  const flags = detail.flags;
  const [isPinned, setIsPinned] = useState((flags?.pinned ?? 0) === 1);
  const [tags, setTags] = useState<string[]>(flags?.tags ?? []);
  const [customTitle, setCustomTitle] = useState(flags?.custom_title ?? '');
  const [isEditing, setIsEditing] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const displayTitle = (customTitle.trim() || detail.title) ?? detail.id;

  /** Returns whether it succeeded — optimistic-update callers use this to roll back (if a failure only shows a small error without rolling back,
   *  the star stays filled while the DB never stored it: the user believes delete-protection is on when it isn't) */
  async function save(update: FlagsUpdate): Promise<boolean> {
    setIsSaving(true);
    try {
      setSaveError('');
      await updateFlags(detail.id, update);
      onChanged?.();
      return true;
    } catch (err) {
      setSaveError(errMessage(err));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  function handleTogglePin() {
    const prev = isPinned;
    setIsPinned(!prev);
    void save({ pinned: !prev }).then((ok) => {
      if (!ok) setIsPinned(prev); // roll back on failure
    });
  }

  // Only save when the value actually changed (blurring without edits shouldn't trigger a refresh)
  function commitTitle() {
    setIsEditing(false);
    if (customTitle === (flags?.custom_title ?? '')) return;
    void save({ custom_title: customTitle.trim() || null });
  }

  function handleAddTag() {
    const t = tagInput.trim();
    if (!t || tags.includes(t) || tags.length >= MAX_TAGS) return;
    const prev = tags;
    const next = [...tags, t];
    setTags(next);
    setTagInput('');
    void save({ tags: next }).then((ok) => {
      if (!ok) {
        setTags(prev); // roll back on failure + restore the input so the user can retry
        setTagInput(t);
      }
    });
  }

  function handleRemoveTag(tag: string) {
    const prev = tags;
    const next = tags.filter((t) => t !== tag);
    setTags(next);
    void save({ tags: next }).then((ok) => {
      if (!ok) setTags(prev); // roll back on failure
    });
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="group flex items-center gap-1.5">
        <button
          type="button"
          className={cn(
            'shrink-0 cursor-pointer rounded-sm p-1 transition-colors hover:bg-accent [&_svg]:size-4',
            isPinned ? 'text-primary' : 'text-muted-foreground/60 hover:text-foreground'
          )}
          title={isPinned ? 'Unpin' : 'Pin this session (top of list + delete protection)'}
          aria-pressed={isPinned}
          aria-label={isPinned ? 'Unpin' : 'Pin this session'}
          disabled={isSaving}
          onClick={handleTogglePin}
        >
          <Star className={cn(isPinned && 'fill-current')} />
        </button>
        {isEditing ? (
          <input
            autoFocus
            className="h-7 min-w-0 flex-1 rounded-sm border border-primary/50 bg-background px-1.5 text-title font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-primary/70"
            value={customTitle}
            placeholder={detail.title ?? detail.id}
            aria-label="Custom session title"
            maxLength={MAX_TITLE_LEN}
            onChange={(e) => setCustomTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setCustomTitle(flags?.custom_title ?? '');
                setIsEditing(false);
              }
            }}
          />
        ) : (
          <>
            <h2 className="min-w-0 truncate text-title font-semibold" title={displayTitle}>
              {displayTitle}
            </h2>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [&_svg]:size-3.5"
              title="Custom title"
              aria-label="Custom session title"
              onClick={() => setIsEditing(true)}
            >
              <Pencil />
            </button>
          </>
        )}
      </div>
      <div data-chrome className="mt-1 flex flex-wrap items-center gap-1">
        {tags.map((t) => (
          <Badge key={t} variant="default">
            <Tag className="size-3 opacity-70" />
            {t}
            <button
              type="button"
              className="cursor-pointer opacity-70 hover:opacity-100 disabled:pointer-events-none disabled:opacity-40"
              disabled={isSaving}
              onClick={() => handleRemoveTag(t)}
              aria-label={`Remove tag ${t}`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          className="h-5 w-20 rounded-sm border border-transparent bg-transparent px-1 text-micro text-foreground placeholder:text-muted-foreground/50 hover:border-border focus-visible:border-border focus-visible:outline-none"
          value={tagInput}
          placeholder="+ Tag"
          aria-label="Add tag"
          maxLength={MAX_TAG_LEN}
          disabled={isSaving}
          onChange={(e) => setTagInput(e.target.value)}
          onBlur={handleAddTag}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddTag();
          }}
        />
      </div>
      {saveError && <span className="text-xs text-destructive">Save failed: {saveError}</span>}
    </div>
  );
}
