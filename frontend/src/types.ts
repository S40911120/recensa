export interface SessionSummary {
  id: string;
  kind: 'main' | 'subagent';
  /** Which tool recorded this session */
  source: 'claude' | 'codex';
  project: string;
  cwd: string | null;
  parent_session: string | null;
  agent_name: string | null;
  agent_type: string | null;
  agent_desc: string | null;
  tool_use_id: string | null;
  task_kind: string | null;
  team_name: string | null;
  model: string | null;
  /** All models used in this session (aggregated by the indexer; > 1 means the session switched models) */
  models: string[];
  title: string | null;
  first_ts: string | null;
  last_ts: string | null;
  msg_count: number;
  user_prompts: number;
  tool_calls: number;
  tokens_out: number;
  tokens_in: number;
  cache_read: number;
  cache_creation: number;
  git_branch: string | null;
  agent_model: string | null;
  spawn_depth: number | null;
  custom_agent_type: string | null;
  forked_from: string | null;
  compact_count: number;
  size: number;
  pinned: number;
  tags: string[];
  custom_title: string | null;
  note: string | null;
  subagent_count: number;
}

export interface SubagentSummary {
  id: string;
  agent_name: string | null;
  agent_type: string | null;
  agent_desc: string | null;
  tool_use_id: string | null;
  /** true = agent-team teammate (meta.json taskKind=in_process_teammate); false = a traditional Task/Agent subagent */
  is_teammate: boolean;
  team_name: string | null;
  agent_model: string | null;
  spawn_depth: number | null;
  custom_agent_type: string | null;
  title: string | null;
  msg_count: number;
  first_ts: string | null;
  last_ts: string | null;
  /** The session that emitted this spawn (= the real parent; a direct child's parent is the main session). Used to locate the call site */
  spawner: string | null;
  /** Nested child agents (grandchildren this agent spawned in turn); empty array in the flat two-level case */
  children: SubagentSummary[];
}

export interface SessionFlags {
  session_id: string;
  pinned: number;
  tags: string[];
  custom_title: string | null;
  note: string | null;
  updated_at: string | null;
}

export interface SessionDetail
  extends Omit<SessionSummary, 'pinned' | 'tags' | 'custom_title' | 'note' | 'subagent_count'> {
  flags: SessionFlags | null;
  subagents: SubagentSummary[];
  chain: SessionChain;
}

export interface AgentLink {
  toolUseId: string | null;
  name: string | null;
  description: string | null;
  subagentType: string | null;
  sessionId?: string;
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown; agentLink: AgentLink | null }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string }
  | { kind: 'image' }
  | { kind: 'other'; type: string };

/** Message origin: human = typed by the user; teammate = teammate report; tool = tool payload; injected = harness-injected; meta = system relay;
 *  boundary = compaction boundary; compact = compaction-summary opener; hook = hook/API event; away = away summary; system_event = local command / system message; queued = a real user message sent from the queue */
export type MessageOrigin =
  | 'human'
  | 'teammate'
  | 'tool'
  | 'injected'
  | 'meta'
  | 'assistant'
  | 'boundary'
  | 'compact'
  | 'hook'
  | 'away'
  | 'system_event'
  | 'queued'
  | 'command';

export interface SystemEventInfo {
  label: string;
  level: string;
}

export interface ErrorDetail {
  status: string | null;
  message: string | null;
}

export interface HookSummary {
  count: number;
  infos: unknown[];
  errors: unknown[];
  additionalContext: string | null;
  preventedContinuation: boolean;
}

export interface ApiErrorInfo {
  error: string;
  retryAttempt: number | null;
  maxRetries: number | null;
}

export interface ChainNode {
  id: string;
  title: string | null;
  compact_count: number;
  missing?: boolean;
}

export interface SessionChain {
  ancestors: ChainNode[];
  children: ChainNode[];
}

/** Parsed teammate message (source: the <teammate-message> tag in the content; jsonl has no dedicated field) */
export interface TeammateInfo {
  id: string | null;
  summary: string | null;
  color: string | null;
  idle: boolean;
  inner: string;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface Message {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant' | 'system';
  origin: MessageOrigin;
  teammate: TeammateInfo | null;
  /** Slash command name (when origin === 'command', e.g. /compact) */
  command?: string | null;
  isApiError?: boolean;
  /** The skill that produced this assistant message (attributionSkill) */
  attributionSkill?: string | null;
  /** stop_reason=max_tokens → the response was truncated */
  truncated?: boolean;
  /** Error detail for rate_limit/429 and similar (supplements the isApiError boolean) */
  errorDetail?: ErrorDetail | null;
  /** Label and severity for a system_event (local_command/informational) */
  system?: SystemEventInfo | null;
  hook?: HookSummary | null;
  apiError?: ApiErrorInfo | null;
  ts: string | null;
  isSidechain: boolean;
  model: string | null;
  usage: TokenUsage | null;
  blocks: Block[];
}

export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
  hasOlder: boolean;
  total: number;
  /** Actual start index (computed by the backend on a tail read) */
  from: number;
  limit: number;
}

export interface ProjectEntry {
  project: string;
  n: number;
  last_ts: string | null;
}

export interface SearchHit {
  session_id: string;
  uuid: string;
  ts: string | null;
  mtype: string;
  snip: string;
  title: string | null;
  project: string;
  kind: 'main' | 'subagent';
  parent_session: string | null;
}
