import { getSessionStats, type SessionStats } from '../services/api';

/** stats is an expensive endpoint (the backend scans and aggregates the whole file) — this
 *  module-level cache uses the session's last_ts as its version key: with no new messages it
 *  always hits (no TTL guessing at freshness); the backend keeps a (size, mtime) result cache
 *  as a second safeguard. */
const cache = new Map<string, { version: string; data: SessionStats }>();
const inflight = new Map<string, Promise<SessionStats>>();

export function fetchSessionStats(id: string, version: string): Promise<SessionStats> {
  const hit = cache.get(id);
  if (hit?.version === version) return Promise.resolve(hit.data);
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = getSessionStats(id)
    .then((data) => {
      cache.set(id, { version, data });
      inflight.delete(id);
      return data;
    })
    .catch((err: unknown) => {
      inflight.delete(id);
      throw err;
    });
  inflight.set(id, p);
  return p;
}
