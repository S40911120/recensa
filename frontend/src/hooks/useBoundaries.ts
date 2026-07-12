import { getBoundaries, type BoundaryNode } from '../services/api';
import { useAsyncResource, type AsyncStatus } from './useAsyncResource';

export type BoundariesStatus = AsyncStatus;

const NO_BOUNDARIES: BoundaryNode[] = [];

/** Compaction-node list (shared by App's segment-boundary derivation, the InfoPanel list, and the Reader reconstructed-view chips) */
export function useBoundaries(
  sessionId: string | null,
  reconstructed = false
): { boundaries: BoundaryNode[]; status: BoundariesStatus } {
  const { data: boundaries, status } = useAsyncResource(
    (signal) => getBoundaries(sessionId as string, reconstructed, signal),
    [sessionId, reconstructed],
    { enabled: !!sessionId, initial: NO_BOUNDARIES }
  );
  return { boundaries, status };
}
