import { useMemo } from 'react';

import type { BoundaryNode } from '../services/api';

interface ReadingPositionInput {
  /** Whether we're in live mode (reading position is shown only in live mode) */
  isLive: boolean;
  /** Total message count for the whole session (approximate) */
  total: number;
  /** Absolute index of the first message in the loaded window */
  startIndex: number;
  /** Number of loaded messages */
  loadedCount: number;
  /** Relative index (within the loaded window) of the top visible item */
  topVisibleRelIndex: number;
  /** Scrolled to the very top / bottom (special-cased as 0% / 100%) */
  atTop: boolean;
  atBottom: boolean;
  /** Compaction nodes (used to compute the "current compaction block %") */
  boundaries: BoundaryNode[];
}

/** Reading-position %: top/bottom special-cased as 0/100, in between the top-of-viewport index ratio is used (avoids a nested ternary) */
function computePositionPct(isLive: boolean, total: number, atTop: boolean, atBottom: boolean, viewportTopAbs: number): number | null {
  if (!isLive || total <= 0) return null;
  if (atBottom) return 100;
  if (atTop) return 0;
  return Math.min(100, Math.round((viewportTopAbs / Math.max(1, total - 1)) * 100));
}

/** Reading-position metrics: overall % + current compaction-block % (Reader's position calculation is consolidated here) */
export function useReadingPosition(input: ReadingPositionInput): { positionPct: number | null; segmentPct: number | null } {
  const { isLive, total, startIndex, loadedCount, topVisibleRelIndex, atTop, atBottom, boundaries } = input;
  const viewportTopAbs = startIndex + topVisibleRelIndex;
  // sort the boundaries only when they change (not re-sorted on the scroll hot path)
  const sortedBoundaryIdx = useMemo(() => [...boundaries.map((b) => b.index)].sort((a, b) => a - b), [boundaries]);

  const positionPct = computePositionPct(isLive, total, atTop, atBottom, viewportTopAbs);

  // Reading position % within the current compaction block: the segment (split by boundaries) that the top of the viewport falls in, as a fraction of that segment's length
  let segmentPct: number | null = null;
  if (isLive && total > 0 && sortedBoundaryIdx.length > 0) {
    let segStart = 0;
    // for the last segment, segEnd uses max(approximate total, loaded tail) so an under-estimated total doesn't stick at 100% too early
    let segEnd = Math.max(total, startIndex + loadedCount);
    for (const bi of sortedBoundaryIdx) {
      if (bi <= viewportTopAbs) segStart = bi;
      else {
        segEnd = bi;
        break;
      }
    }
    const segLen = segEnd - segStart;
    if (segLen > 0) {
      if (atBottom && viewportTopAbs >= segStart && segEnd >= startIndex + loadedCount) segmentPct = 100;
      else segmentPct = Math.min(100, Math.round(((viewportTopAbs - segStart) / Math.max(1, segLen - 1)) * 100));
    }
  }
  return { positionPct, segmentPct };
}
