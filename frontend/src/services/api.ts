import type {
  MessagesPage,
  ProjectEntry,
  SearchHit,
  SessionDetail,
  SessionSummary,
} from '../types';

/** Fetch error carrying the HTTP status, so callers can tell an expected 404 from a genuine 5xx failure */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new HttpError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface SessionListParams {
  project?: string;
  q?: string;
  sid?: string;
  model?: string;
  since?: string;
  until?: string;
  pinned?: boolean;
  tag?: string;
  /** Which tool recorded the session ('claude' | 'codex'); omitted = all sources */
  source?: string;
  limit?: number;
  offset?: number;
}

export function listSessions(params: SessionListParams, signal?: AbortSignal): Promise<SessionSummary[]> {
  const sp = new URLSearchParams();
  if (params.project) sp.set('project', params.project);
  if (params.q) sp.set('q', params.q);
  if (params.sid) sp.set('sid', params.sid);
  if (params.model) sp.set('model', params.model);
  if (params.since) sp.set('since', params.since);
  if (params.until) sp.set('until', params.until);
  if (params.pinned) sp.set('pinned', '1');
  if (params.tag) sp.set('tag', params.tag);
  if (params.source) sp.set('source', params.source);
  sp.set('limit', String(params.limit ?? 60));
  sp.set('offset', String(params.offset ?? 0));
  return getJson<SessionSummary[]>(`/api/sessions?${sp.toString()}`, signal);
}

export function listProjects(source?: string, signal?: AbortSignal): Promise<ProjectEntry[]> {
  const sp = new URLSearchParams();
  if (source) sp.set('source', source);
  return getJson<ProjectEntry[]>(`/api/projects?${sp.toString()}`, signal);
}

export function getSession(id: string, signal?: AbortSignal): Promise<SessionDetail> {
  return getJson<SessionDetail>(`/api/session/${encodeURIComponent(id)}`, signal);
}

export function getMessages(
  id: string,
  from: number | 'tail',
  limit: number,
  signal?: AbortSignal,
  reconstructed = false
): Promise<MessagesPage> {
  const base = reconstructed ? 'reconstructed/messages' : 'messages';
  return getJson<MessagesPage>(
    `/api/session/${encodeURIComponent(id)}/${base}?from=${from}&limit=${limit}`,
    signal
  );
}

/** `source` is required so a search never mixes Claude Code and Codex results together. */
export function searchAll(q: string, source: string, limit = 50, signal?: AbortSignal): Promise<SearchHit[]> {
  return getJson<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}&limit=${limit}`, signal);
}

export function listTags(signal?: AbortSignal): Promise<string[]> {
  return getJson<string[]>('/api/tags', signal);
}

export interface FlagsUpdate {
  pinned?: boolean;
  tags?: string[];
  custom_title?: string | null;
  note?: string | null;
}

export async function updateFlags(id: string, update: FlagsUpdate): Promise<void> {
  const res = await fetch(`/api/session/${encodeURIComponent(id)}/flags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`Failed to update flags: HTTP ${res.status}`);
}

export interface BoundaryNode {
  index: number;
  ts: string | null;
}

export interface SkillUsage {
  name: string;
  count: number;
  firstTs: string | null;
}

/** Skills used in this session (aggregated from Skill tool_use) */
export function getSkills(id: string, signal?: AbortSignal): Promise<SkillUsage[]> {
  return getJson<SkillUsage[]>(`/api/session/${encodeURIComponent(id)}/skills`, signal);
}

/** Search-hit jump: uuid → its index within the session */
export async function locateMessage(id: string, uuid: string, signal?: AbortSignal): Promise<number> {
  const r = await getJson<{ index: number }>(
    `/api/session/${encodeURIComponent(id)}/locate?uuid=${encodeURIComponent(uuid)}`,
    signal
  );
  return r.index;
}

/** Target for locating a spawn call site: match precisely on toolUseId; when meta has no
 *  toolUseId, fall back to matching on name + occurrence (nth = which spawn among several with
 *  the same name, so they don't all jump to the first one). */
export type SpawnLocateTarget = { toolUseId: string } | { agentName: string; nth: number };

/** Locate the message index that emitted a given Agent/Task spawn (jump to a subagent's call site).
 *  Not found (404, file changed) returns -1 (callers stay silent); genuine errors (5xx/network)
 *  are rethrown rather than masked as -1. */
export async function locateSpawnCall(id: string, target: SpawnLocateTarget, signal?: AbortSignal): Promise<number> {
  const q = 'toolUseId' in target
    ? `toolUseId=${encodeURIComponent(target.toolUseId)}`
    : `agentName=${encodeURIComponent(target.agentName)}&nth=${target.nth}`;
  try {
    const r = await getJson<{ index: number }>(`/api/session/${encodeURIComponent(id)}/locate?${q}`, signal);
    return r.index;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return -1; // expected not-found
    throw e; // don't swallow genuine errors
  }
}

export function getBoundaries(id: string, reconstructed = false, signal?: AbortSignal): Promise<BoundaryNode[]> {
  return getJson<BoundaryNode[]>(
    `/api/session/${encodeURIComponent(id)}/boundaries${reconstructed ? '?reconstructed=1' : ''}`,
    signal
  );
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/session/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
}

export interface FileEditRecord { ts: string; type: 'edit' | 'write'; old?: string; next?: string; content?: string; }
export interface SessionStats {
  overview: { msgCount: number; assistantCount: number; userMsgCount: number; firstTs: string | null; lastTs: string | null };
  tools: { name: string; count: number }[];
  files: { path: string; edits: number; tools: string[]; isNew: boolean; content: string | null; history: FileEditRecord[] }[];
  deleted: { path: string; ts: string }[];
  models: { name: string; count: number }[];
}

export function getSessionStats(id: string, signal?: AbortSignal): Promise<SessionStats> {
  return getJson<SessionStats>(`/api/session/${encodeURIComponent(id)}/stats`, signal);
}

export function getSettings(signal?: AbortSignal): Promise<Record<string, string>> {
  return getJson<Record<string, string>>('/api/settings', signal);
}

export async function saveSettings(updates: Record<string, string>): Promise<void> {
  const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  if (!res.ok) throw new Error('Failed to save settings');
}
