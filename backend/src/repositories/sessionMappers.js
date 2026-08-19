'use strict';
// API DTO layer: a DB row is not the HTTP contract. Fields are selected explicitly: the internal `file` column
// (the absolute on-disk jsonl path) is withheld, while `cwd` (also an absolute path) is deliberately included in
// toSessionDto below because the UI displays it — safe here as this is a single-user, own-data viewer.

/** model_names JSON -> string[]; a bad value/null returns [] (historical rows are null before backfill) */
function parseModels(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((m) => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

function toSessionDto(row) {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    project: row.project,
    cwd: row.cwd,
    parent_session: row.parent_session,
    agent_name: row.agent_name,
    agent_type: row.agent_type,
    agent_desc: row.agent_desc,
    tool_use_id: row.tool_use_id,
    task_kind: row.task_kind,
    team_name: row.team_name,
    model: row.model,
    models: parseModels(row.model_names),
    title: row.title,
    first_ts: row.first_ts,
    last_ts: row.last_ts,
    msg_count: row.msg_count,
    user_prompts: row.user_prompts,
    tool_calls: row.tool_calls,
    tokens_out: row.tokens_out,
    tokens_in: row.tokens_in,
    cache_read: row.cache_read,
    cache_creation: row.cache_creation ?? 0,
    git_branch: row.git_branch ?? null,
    agent_model: row.agent_model ?? null,
    spawn_depth: row.spawn_depth ?? null,
    custom_agent_type: row.custom_agent_type ?? null,
    forked_from: row.forked_from,
    compact_count: row.compact_count,
    size: row.size,
  };
}

function toSessionListItemDto(row) {
  return {
    ...toSessionDto(row),
    pinned: row.pinned,
    tags: row.tags,
    custom_title: row.custom_title,
    note: row.note,
    subagent_count: row.subagent_count,
  };
}

function toSubagentDto(row) {
  return {
    id: row.id,
    agent_name: row.agent_name,
    agent_type: row.agent_type,
    agent_desc: row.agent_desc,
    tool_use_id: row.tool_use_id,
    // The mechanical key that distinguishes a teammate (a member of an agent team) from a traditional subagent (meta.json taskKind)
    is_teammate: row.task_kind === 'in_process_teammate',
    team_name: row.team_name,
    agent_model: row.agent_model ?? null,
    spawn_depth: row.spawn_depth ?? null,
    custom_agent_type: row.custom_agent_type ?? null,
    title: row.title,
    msg_count: row.msg_count,
    first_ts: row.first_ts,
    last_ts: row.last_ts,
  };
}

/** DTO for a subagent nesting-tree node (recursively carries children); spawner = the session that emitted the dispatch (used to locate the call site) */
function toSubagentTreeDto(node) {
  return {
    ...toSubagentDto(node),
    spawner: node.spawner ?? null,
    children: Array.isArray(node.children) ? node.children.map(toSubagentTreeDto) : [],
  };
}

// toSubagentDto is only used internally by toSubagentTreeDto in this file and is not exported (routes only use the tree version)
module.exports = { toSessionDto, toSessionListItemDto, toSubagentTreeDto };
