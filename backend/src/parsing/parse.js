'use strict';
// JSONL record -> structured message (read-only). The origin classification lets the frontend distinguish human-typed messages from injected ones.

/** Known content prefixes the harness injects into the user role (not typed by the human). */
const INJECTED_PREFIXES = [
  '<teammate-message',
  '<task-notification',
  '<system-reminder',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout',
  '<scheduled-task',
  'Caveat:',
  '[Request interrupted',
];

function isInjectedText(text) {
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

// A single \s + [^>]* has no quantifier overlap -> linear; \s+[^>]* lets both consume whitespace, causing O(n^2) backtracking (a hostile jsonl line could freeze the event loop)
const TEAMMATE_TAG_RE = /<teammate-message\s([^>]*)>/;
// Slash-command records: a user record's content holds <command-name>/xxx</command-name> (e.g. /compact and ~14 other commands)
const COMMAND_NAME_RE = /<command-name>([^<]+)<\/command-name>/;
function extractCommandName(text) {
  const m = COMMAND_NAME_RE.exec(text);
  return m ? m[1].trim() : null;
}

/** Teammate message parsing: the jsonl has no dedicated field (userType is still "external"); the only
 *  reliable marker is the <teammate-message teammate_id=... summary=...> tag inside the content. */
function parseTeammate(text) {
  const m = TEAMMATE_TAG_RE.exec(text);
  if (!m) return null;
  const attrs = {};
  const attrRe = /(\w+)="([^"]*)"/g;
  let a = attrRe.exec(m[1]);
  while (a) {
    attrs[a[1]] = a[2];
    a = attrRe.exec(m[1]);
  }
  const inner = text
    .slice(m.index + m[0].length)
    .replace(/<\/teammate-message>[\s\S]*$/, '')
    .trim();
  return {
    id: attrs.teammate_id || null,
    summary: attrs.summary || null,
    color: attrs.color || null,
    idle: /"type"\s*:\s*"idle_notification"/.test(inner),
    inner,
  };
}

// A pathologically deep record (nested tool_result content, e.g. depth ~20000) would overflow the call stack
// and make extractText throw RangeError. That diverges the read paths: toMessage recurses -> throws -> the record
// is dropped and the index is NOT advanced, while countsAsMessage returns true WITHOUT recursing -> the index IS
// advanced. The same record then lands at different indices under different `from` -> reader-vs-reader paging drift.
// The cap stops recursion at a depth no real transcript reaches (tool_result nesting is 1-2 levels in practice) and
// emits a bounded placeholder, so toMessage and countsAsMessage AGREE the record is a (non-null) message.
const MAX_EXTRACT_DEPTH = 100;

/** Extract plain text from content (a string or a block array); `depth` bounds recursion into nested tool_result content. */
function extractText(content, depth = 0) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (depth >= MAX_EXTRACT_DEPTH) return '[nested content too deep]';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push(b.thinking);
    else if (b.type === 'tool_result') {
      const inner = extractText(b.content, depth + 1);
      if (inner) parts.push(inner);
    }
  }
  return parts.join('\n');
}

/** Origin detection for block-array content (extracted to reduce classifyUserOrigin complexity). */
function classifyArrayContent(content) {
  const hasToolResult = content.some((b) => b?.type === 'tool_result');
  const textBlocks = content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
  if (textBlocks.length > 0) {
    // If any text block is genuine human text, treat it as human (avoids mislabeling a record whose first block is injected but a later block is human)
    return textBlocks.some((b) => !isInjectedText(b.text)) ? 'human' : 'injected';
  }
  return hasToolResult ? 'tool' : 'meta';
}

/** Classify the origin of a user record: human | teammate | tool | injected | meta.
 *  Prefer structured fields (origin.kind / teamName), which are more authoritative than heuristics, then fall back. */
function classifyUserOrigin(record, msg) {
  if (record.isMeta) return 'meta';
  const content = msg.content;
  const fullText = typeof content === 'string' ? content : extractText(content);
  // teamName is a teammate-only field; the tag regex is the secondary check (used only when the field is absent, relying on the content tag)
  if (record.teamName || TEAMMATE_TAG_RE.test(fullText)) return 'teammate';
  // Slash commands (/compact etc.) take priority over injected/tool, otherwise they get buried under the generic "system-injected" bucket and stay invisible
  if (extractCommandName(fullText)) return 'command';
  // The structured origin.kind (human / task-notification / ...) takes priority over text heuristics
  const kind = record.origin?.kind;
  if (kind === 'human' && !record.toolUseResult) return 'human';
  // A top-level toolUseResult field is the mechanical signal for a tool-result carrier (empirically ~87% of user records carry it in Claude Code 2.1.19x)
  if (record.toolUseResult) return 'tool';
  if (Array.isArray(content)) return classifyArrayContent(content);
  if (typeof content === 'string' && content.trim()) {
    return isInjectedText(content) ? 'injected' : 'human';
  }
  return 'meta';
}

/** Agent/Task dispatch tool_use -> subagent linkage info */
function agentLinkInfo(block) {
  if (block.type !== 'tool_use') return null;
  if (block.name !== 'Agent' && block.name !== 'Task') return null;
  const input = block.input || {};
  return {
    toolUseId: block.id || null,
    name: typeof input.name === 'string' ? input.name : null,
    description: typeof input.description === 'string' ? input.description : null,
    subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : null,
  };
}

// System subtypes that toMessage renders and that must be counted in sync with forIndex (compact_boundary is counted separately as compactCount and is not in this set)
const SHOWN_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'api_error', 'away_summary', 'local_command', 'informational']);

/** Wrap non-empty text in a single text block, otherwise an empty array (shared by the system message cards). */
function textBlock(text) {
  return text ? [{ kind: 'text', text }] : [];
}

/** Stop-hook summary card: list of hooks plus errors (about 45% of system events). */
function buildHookSummary(record, base) {
  const infos = Array.isArray(record.hookInfos) ? record.hookInfos : [];
  const errors = Array.isArray(record.hookErrors) ? record.hookErrors : [];
  return {
    ...base,
    origin: 'hook',
    hook: {
      count: record.hookCount || infos.length,
      infos,
      errors,
      additionalContext: record.hookAdditionalContext || null,
      preventedContinuation: !!record.preventedContinuation,
    },
    blocks: [],
  };
}

/** API error event card (includes retry info). */
function buildApiError(record, base) {
  return {
    ...base,
    origin: 'hook',
    hook: null,
    apiError: {
      error: typeof record.error === 'string' ? record.error : JSON.stringify(record.error || ''),
      retryAttempt: record.retryAttempt || null,
      maxRetries: record.maxRetries || null,
    },
    blocks: [],
  };
}

/** system record -> rendered message (returns null for subtypes not listed in SHOWN_SYSTEM_SUBTYPES). */
function parseSystemRecord(record) {
  const base = {
    uuid: record.uuid,
    parentUuid: record.parentUuid || null,
    type: 'system',
    teammate: null,
    ts: record.timestamp || null,
    isSidechain: !!record.isSidechain,
    model: null,
    usage: null,
  };
  const contentStr = typeof record.content === 'string' ? record.content : '';
  // Context-compaction boundary: a reading landmark (the original text before this point has been replaced by a summary)
  if (record.subtype === 'compact_boundary') {
    return { ...base, origin: 'boundary', blocks: [] };
  }
  // Away/idle summary: a narrative recap of session progress (equivalent to a handoff) -> summary card
  if (record.subtype === 'away_summary') {
    const text = contentStr.replace(/\s*\(disable recaps[^)]*\)\s*$/, '');
    return { ...base, origin: 'away', blocks: textBlock(text) };
  }
  // Output of an executed slash command / local command -> system event row
  if (record.subtype === 'local_command') {
    return { ...base, origin: 'system_event', system: { label: 'Local command', level: 'info' }, blocks: textBlock(contentStr) };
  }
  // Info/warning (unknown command, model could not be restored, ...) -> system event row (colored by level)
  if (record.subtype === 'informational') {
    return { ...base, origin: 'system_event', system: { label: 'System message', level: record.level || 'info' }, blocks: textBlock(contentStr) };
  }
  // Stop-hook summary: list of hooks plus errors (about 45% of system events)
  if (record.subtype === 'stop_hook_summary') return buildHookSummary(record, base);
  // API error event (includes retry info)
  if (record.subtype === 'api_error') return buildApiError(record, base);
  return null;
}

/** message.content (string or block array) -> viewer blocks */
function parseContentBlocks(content) {
  const blocks = [];
  if (typeof content === 'string') {
    blocks.push({ kind: 'text', text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
        blocks.push({ kind: 'text', text: b.text || '' });
        break;
      case 'thinking': {
        // The jsonl genuinely contains empty thinking blocks; skip them so they do not render as noise
        const thinkingText = typeof b.thinking === 'string' ? b.thinking : '';
        if (thinkingText.trim()) blocks.push({ kind: 'thinking', text: thinkingText });
        break;
      }
      case 'tool_use':
        blocks.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input, agentLink: agentLinkInfo(b) });
        break;
      case 'tool_result':
        blocks.push({
          kind: 'tool_result',
          toolUseId: b.tool_use_id,
          isError: !!b.is_error,
          text: extractText(b.content),
        });
        break;
      case 'image':
        blocks.push({ kind: 'image' });
        break;
      default:
        blocks.push({ kind: 'other', type: b.type });
    }
  }
  return blocks;
}

/** Shared enqueue predicate: a queue-operation counts as a rendered message only when it is an `enqueue` carrying
 *  non-empty, non-injected human text. Single source for parseQueueOperation / countsAsMessage / forIndexQueue
 *  (mirrors how the system half shares SHOWN_SYSTEM_SUBTYPES) -- the three MUST agree or the msg_count/paging total drifts. */
function enqueueCounts(record) {
  if (record.operation !== 'enqueue') return false;
  const text = typeof record.content === 'string' ? record.content : '';
  return Boolean(text.trim()) && !isInjectedText(text);
}

/** queue-operation -> a human message queued for sending (rendered only when enqueue carries non-injected content).
 *  Only genuine queued human prompts count: injected types (task-notification etc.) and remove/empty bodies are not rendered. */
function parseQueueOperation(record) {
  if (!enqueueCounts(record)) return null;
  const text = typeof record.content === 'string' ? record.content : '';
  return {
    uuid: record.uuid || `queue-${record.timestamp || ''}`,
    parentUuid: null,
    type: 'user',
    origin: 'queued',
    teammate: null,
    ts: record.timestamp || null,
    isSidechain: false,
    model: null,
    usage: null,
    blocks: [{ kind: 'text', text }],
  };
}

/** Assistant error detail (error / apiErrorStatus) -> { status, message }, or null when there is no error */
function buildErrorDetail(record, msg, type) {
  if (type !== 'assistant' || !(msg.error || record.apiErrorStatus)) return null;
  return {
    status: record.apiErrorStatus == null ? null : String(record.apiErrorStatus),
    message: typeof msg.error === 'string' ? msg.error : null,
  };
}

/** Reasoning effort Claude Code recorded on an assistant record (record-level perTurnEffort/effort, CC >= ~2.1.2xx); null otherwise */
function recordEffort(record) {
  if (record.type !== 'assistant') return null;
  const effort = record.perTurnEffort || record.effort;
  return typeof effort === 'string' ? effort : null;
}

/** user/assistant record -> viewer message object (type already confirmed by toMessage) */
function buildChatMessage(record, type) {
  const msg = record.message || {};
  const content = msg.content;
  const blocks = parseContentBlocks(content);
  let origin = type === 'assistant' ? 'assistant' : classifyUserOrigin(record, msg);
  // Compaction summary preamble (the condensed text loaded after resume/compact): its own origin, rendered by the frontend as an opening card
  if (type === 'user' && record.isCompactSummary) origin = 'compact';
  const teammate = origin === 'teammate' ? parseTeammate(extractText(content)) : null;
  const command = origin === 'command' ? extractCommandName(extractText(content)) : null;
  // Additional high-value fields pulled from the record: skill attribution / truncation / error detail
  const attribution = type === 'assistant' && typeof msg.attributionSkill === 'string' ? msg.attributionSkill : null;
  const truncated = type === 'assistant' && msg.stop_reason === 'max_tokens';
  return {
    uuid: record.uuid,
    parentUuid: record.parentUuid || null,
    type,
    origin,
    teammate,
    command,
    isApiError: !!record.isApiErrorMessage,
    attributionSkill: attribution,
    truncated,
    errorDetail: buildErrorDetail(record, msg, type),
    ts: record.timestamp || null,
    isSidechain: !!record.isSidechain,
    model: msg.model || null,
    effort: recordEffort(record),
    usage: msg.usage || null,
    blocks,
  };
}

/** One JSONL line -> viewer message object (type dispatch + assembly; details live in parseSystemRecord / parseContentBlocks) */
function toMessage(record) {
  if (!record || typeof record !== 'object') return null;
  const { type } = record;
  if (type === 'system') return parseSystemRecord(record);
  if (type === 'queue-operation') return parseQueueOperation(record);
  if (type !== 'user' && type !== 'assistant') return null;
  return buildChatMessage(record, type);
}

/**
 * Cheap predicate: does this record count as a rendered message? Returns exactly `toMessage(record) !== null`
 * WITHOUT building the (potentially expensive) message object. The read layer uses this to advance the message
 * index over discarded lines (the `index < from` prefix / readTail's counting pass) without paying full toMessage().
 * Kept in lockstep with toMessage by parse.test.js (the msg_count alignment invariant): changing which lines count
 * as a message must change toMessage, forIndex, AND this predicate together, or the paging total drifts.
 */
function countsAsMessage(record) {
  if (!record || typeof record !== 'object') return false;
  const { type } = record;
  if (type === 'user' || type === 'assistant') return true; // buildChatMessage never returns null
  if (type === 'system') return record.subtype === 'compact_boundary' || SHOWN_SYSTEM_SUBTYPES.has(record.subtype);
  if (type === 'queue-operation') return enqueueCounts(record);
  return false;
}

/** Title-type record (summary / ai-title / custom-title) -> index summary; returns null when it is not a title */
function forIndexTitle(record) {
  if (record.type === 'summary' && typeof record.summary === 'string') {
    return { summary: record.summary };
  }
  // Title sources (in Claude Code 2.1.19x the summary type is extinct; ai-title / custom-title are the live title records)
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
    return { aiTitle: record.aiTitle };
  }
  if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
    return { customTitle: record.customTitle };
  }
  return null;
}

/** Index summary for a system record (counted in sync with the set toMessage renders); returns null for non-rendered subtypes */
function forIndexSystem(record, recForkedFrom) {
  if (record.subtype === 'compact_boundary') {
    // In resume files, forkedFrom is usually attached to the first-line boundary record
    return { boundary: true, ts: record.timestamp || null, forkedFrom: recForkedFrom };
  }
  // Every system subtype that toMessage renders must be counted (otherwise the pagination total drifts)
  if (SHOWN_SYSTEM_SUBTYPES.has(record.subtype)) {
    const text = typeof record.content === 'string' ? record.content : '';
    // The uuid is required (FTS hits rely on it to locate and jump; a hit without a uuid cannot be positioned)
    return { systemMsg: true, uuid: record.uuid || null, ts: record.timestamp || null, forkedFrom: recForkedFrom, text, mtype: 'system' };
  }
  return null;
}

/** Index summary for a queue-operation: aligned with toMessage -- only an enqueue carrying non-injected human text is counted
 *  (kept out of FTS to avoid duplicate hits with the sent record) */
function forIndexQueue(record, recForkedFrom) {
  if (enqueueCounts(record)) {
    return { systemMsg: true, ts: record.timestamp || null, forkedFrom: recForkedFrom };
  }
  return null;
}

/** Count of tool_use blocks in msg.content */
function countToolUse(content) {
  return Array.isArray(content)
    ? content.reduce((n, b) => (b?.type === 'tool_use' ? n + 1 : n), 0)
    : 0;
}

/** Agent/Task dispatch tool_use ids emitted by this record (builds the subagent nesting tree: emitter -> true parent) */
function collectAgentSpawns(content) {
  return Array.isArray(content)
    ? content.filter((b) => b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && b.id).map((b) => b.id)
    : [];
}

/** usage -> token stat fields (true prompt cost = input + cache_creation + cache_read; omitting cache_creation underestimates it) */
function tokenStats(usage) {
  return {
    tokensOut: usage.output_tokens || 0,
    tokensIn: usage.input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheCreation: usage.cache_creation_input_tokens || 0,
  };
}

/** Index summary for a user/assistant record */
function forIndexMessage(record, recForkedFrom) {
  const msg = record.message || {};
  const text = extractText(msg.content);
  const origin = record.type === 'assistant' ? 'assistant' : classifyUserOrigin(record, msg);
  const usage = msg.usage || {};
  return {
    uuid: record.uuid,
    ts: record.timestamp || null,
    mtype: record.type,
    text,
    isUserPrompt: origin === 'human' && !record.isSidechain && !!text,
    model: msg.model || null,
    effort: recordEffort(record),
    cwd: record.cwd || null,
    gitBranch: record.gitBranch || null,
    forkedFrom: recForkedFrom,
    toolCalls: countToolUse(msg.content),
    agentSpawns: collectAgentSpawns(msg.content),
    ...tokenStats(usage),
  };
}

/** Index summary */
function forIndex(record) {
  if (!record || typeof record !== 'object') return null;
  const title = forIndexTitle(record);
  if (title) return title;
  // System events must be counted in sync with the set toMessage returns (to keep the pagination total aligned)
  const recForkedFrom = record.forkedFrom?.sessionId || null;
  if (record.type === 'system') return forIndexSystem(record, recForkedFrom);
  if (record.type === 'queue-operation') return forIndexQueue(record, recForkedFrom);
  if (record.type !== 'user' && record.type !== 'assistant') return null;
  return forIndexMessage(record, recForkedFrom);
}

module.exports = { toMessage, countsAsMessage, forIndex, extractText, isInjectedText };
