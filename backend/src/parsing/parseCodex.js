'use strict';
// Codex rollout JSONL record -> viewer message (read-only). Codex's format differs entirely from Claude's
// (OpenAI Responses API items: response_item.payload.type is message/function_call/function_call_output/reasoning,
// plus event_msg/turn_context/session_meta records that carry no independent conversation content -- those are
// skipped here since response_item already carries everything toMessage renders).
const crypto = require('node:crypto');

/** Markers Codex injects into a 'user'-role message alongside (or instead of) the human's own text
 *  (AGENTS.md, sandbox/environment/collaboration-mode boilerplate resent at the start of most turns). */
const INJECTED_MARKERS = [
  '# AGENTS.md instructions',
  '<environment_context>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<app-context>',
];

function isInjectedText(text) {
  return INJECTED_MARKERS.some((m) => text.includes(m));
}

/** response_item message content (array of {type:'input_text'|'output_text', text}) -> joined plain text */
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// notes: no per-line uuid exists in Codex's rollout format (unlike Claude's record.uuid) -> derive a stable
// one from the record's own content. A hash collision (two byte-identical lines) is low-stakes here: it only
// affects the locate-by-uuid jump feature, not indexing correctness.
function syntheticUuid(record) {
  return crypto.createHash('sha1').update(JSON.stringify(record)).digest('hex').slice(0, 24);
}

function textBlocks(text) {
  return text ? [{ kind: 'text', text }] : [];
}

/** role:'user'|'developer' response_item -> viewer message. 'developer' is always harness-injected (sandbox/
 *  app-context boilerplate); 'user' is human unless it matches the same injected boilerplate markers. */
function buildUserMessage(record, payload, base) {
  const text = extractText(payload.content);
  const injected = payload.role === 'developer' || isInjectedText(text);
  return { ...base, origin: injected ? 'injected' : 'human', blocks: textBlocks(text) };
}

function buildAssistantMessage(record, payload, base) {
  return { ...base, type: 'assistant', origin: 'assistant', blocks: textBlocks(extractText(payload.content)) };
}

function buildFunctionCall(record, payload, base) {
  let input = payload.arguments;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { /* keep the raw string when it isn't valid JSON */ }
  }
  return {
    ...base,
    type: 'assistant',
    origin: 'assistant',
    blocks: [{ kind: 'tool_use', id: payload.call_id || base.uuid, name: payload.name || 'unknown_tool', input, agentLink: null }],
  };
}

function buildFunctionCallOutput(record, payload, base) {
  const out = typeof payload.output === 'string' ? payload.output : (payload.output?.content ?? JSON.stringify(payload.output ?? ''));
  const isError = /^Exit code: (?!0\b)/.test(out) || Boolean(payload.output?.success === false);
  return { ...base, origin: 'tool', blocks: [{ kind: 'tool_result', toolUseId: payload.call_id || '', isError, text: out }] };
}

/** Fallback for item types this viewer doesn't specifically render (web_search_call, local_shell_call, ...) --
 *  shown as a generic system event rather than silently dropped, so nothing vanishes unexplained. */
function buildOther(record, payload, base) {
  return { ...base, type: 'system', origin: 'system_event', system: { label: payload.type, level: 'info' }, blocks: [] };
}

const MESSAGE_BUILDERS = {
  function_call: buildFunctionCall,
  function_call_output: buildFunctionCallOutput,
};

/** One JSONL line (already JSON.parse'd) -> viewer message object, or null (reasoning / non-response_item records). */
function toMessage(record) {
  if (!record || typeof record !== 'object' || record.type !== 'response_item') return null;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type === 'reasoning') return null; // encrypted_content only -- nothing plaintext to show
  const base = {
    uuid: syntheticUuid(record),
    parentUuid: null,
    type: 'user',
    teammate: null,
    ts: record.timestamp || null,
    isSidechain: false,
    model: null,
    usage: null,
  };
  if (payload.type === 'message') {
    if (payload.role === 'assistant') return buildAssistantMessage(record, payload, base);
    return buildUserMessage(record, payload, base);
  }
  const builder = MESSAGE_BUILDERS[payload.type];
  return builder ? builder(record, payload, base) : buildOther(record, payload, base);
}

// notes: no cheap forIndex/countsAsMessage split like parse.js -- Codex sessions run to hundreds of lines,
// not Claude's 100k+, so the perf win from a lighter predicate isn't worth the duplicated logic here.
// Upgrade path: mirror parse.js's split if a Codex session ever gets large enough to matter.
function countsAsMessage(record) {
  return toMessage(record) !== null;
}

module.exports = { toMessage, countsAsMessage, extractText, isInjectedText };
