import { Bot, ChevronRight, History as HistoryIcon, House, Scissors, WifiOff } from 'lucide-react';

import type { ReaderMode } from '../../hooks/useMessages';
import type { SessionDetail } from '../../types';
import { Button } from '../ui/button';

interface ReaderBreadcrumbProps {
  detail: SessionDetail;
  trail: string[];
  mode: ReaderMode;
  /** Live-tail connection is up (shows a reconnecting hint when dropped) */
  isLive: boolean;
  isReady: boolean;
  onNavigate: (trailIndex: number) => void;
}

/** Center-column top breadcrumb: live mode shows the trail navigation; reconstructed/segment views show a mode marker + a back-to-main link */
export function ReaderBreadcrumb({ detail, trail, mode, isLive, isReady, onNavigate }: Readonly<ReaderBreadcrumbProps>) {
  return (
    <nav className="flex items-center gap-1 border-b border-border bg-background/95 px-4 py-1.5 text-xs backdrop-blur">
      {mode.type !== 'live' && (
        <>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-primary [&_svg]:size-3.5"
            title="Back to main"
            onClick={() => {
              globalThis.location.hash = `#/session/${detail.id}`;
            }}
          >
            <House />
            Back to main
          </button>
          <ChevronRight className="size-3 text-muted-foreground" />
        </>
      )}
      {mode.type === 'segment' && (
        <span className="inline-flex items-center gap-1.5 font-semibold text-primary [&_svg]:size-3.5">
          <Scissors />
          Compaction segment — original text consumed by compaction #{mode.k} (positions {mode.range.start}–{mode.range.end - 1}, read-only)
        </span>
      )}
      {mode.type === 'reconstructed' && (
        <span className="inline-flex items-center gap-1.5 font-semibold text-primary [&_svg]:size-3.5">
          <HistoryIcon />
          Reconstructed view — full pre-compaction conversation merged along the fork/resume chain (read-only snapshot)
        </span>
      )}
      {mode.type === 'live' &&
        trail.map((id, i) => {
          const isLast = i === trail.length - 1;
          const Icon = i === 0 ? House : Bot;
          const nonMainLabel =
            isLast && detail.kind === 'subagent'
              ? (detail.agent_name ?? detail.agent_desc ?? 'subagent')
              : `subagent ${i}`;
          const label = i === 0 ? 'Main' : nonMainLabel;
          return (
            // trail can theoretically contain duplicate ids, so a composite key avoids collisions
            <span key={`${i}:${id}`} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3 text-muted-foreground" />}
              {isLast ? (
                <span className="inline-flex items-center gap-1 font-semibold text-foreground [&_svg]:size-3">
                  <Icon className={i > 0 ? 'text-subagent' : 'text-primary'} />
                  {label}
                </span>
              ) : (
                <Button variant="link" size="sm" className="h-auto p-0 text-xs [&_svg]:size-3" onClick={() => onNavigate(i)}>
                  <Icon className={i > 0 ? 'text-subagent' : ''} />
                  {label}
                </Button>
              )}
            </span>
          );
        })}
      {mode.type === 'live' && !isLive && isReady && (
        <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground" title="Live updates disconnected, reconnecting">
          <WifiOff className="size-3" />
          Reconnecting
        </span>
      )}
    </nav>
  );
}
