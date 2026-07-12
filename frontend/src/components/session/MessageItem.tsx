import {
  Bot,
  Brain,
  CircleAlert,
  CornerDownLeft,
  CornerDownRight,
  FilePenLine,
  FileText,
  Globe,
  Image as ImageIcon,
  Inbox,
  ListChecks,
  MessageSquareText,
  Puzzle,
  Search,
  SquareArrowOutUpRight,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { memo, useMemo } from 'react';

import { lineDiff } from '../../lib/linediff';
import { highlightCode, renderMarkdown } from '../../lib/md';
import { cn } from '../../lib/utils';
import type { AgentLink, Block, Message } from '../../types';
import { Button } from '../ui/button';
import {
  AwayCard,
  BoundaryDivider,
  CommandRow,
  CompactCard,
  HookRow,
  QueuedRow,
  SystemEventRow,
  TeammateCard,
} from './message/LandmarkCards';
import { CopyButton, FlatRow, joinText, metaText, StructuredView, truncate, type TextBlock } from './message/MessageParts';

const INPUT_PREVIEW_MAX = 4000;
const RESULT_PREVIEW_MAX = 8000;

/** Tool-presentation registry — single SoT for icon / color / edit detection / label extraction; adding a tool means editing only this table */
interface ToolMeta {
  icon: LucideIcon;
  color: string;
  /** Edit/MultiEdit/Write kind: input is shown as a before/after comparison */
  isEdit?: boolean;
  /** Extract a single-line summary from the input (null if none) */
  detail?: (o: Record<string, unknown>) => string | null;
}

const asStr = (o: Record<string, unknown>, k: string): string | null => {
  const v = o[k];
  return typeof v === 'string' ? v : null;
};
const fileDetail = (o: Record<string, unknown>): string | null => {
  const fp = asStr(o, 'file_path') ?? asStr(o, 'filePath');
  return fp ? (fp.split('/').pop() ?? fp) : null;
};
const patternDetail = (o: Record<string, unknown>): string | null => {
  const p = asStr(o, 'pattern');
  return p ? `"${p.slice(0, 60)}"` : null;
};

// Read the theme chart variables (SoT lives in each theme block in styles.css; same color language as the stats dialog, following the active theme)
const TOOL_COLOR = {
  edit: 'var(--chart-3)',
  read: 'var(--chart-1)',
  run: 'var(--chart-8)',
  web: 'var(--chart-6)',
  agent: 'var(--chart-7)',
  other: 'var(--chart-4)',
} as const;

const TOOL_META: Record<string, ToolMeta> = {
  Edit: { icon: FilePenLine, color: TOOL_COLOR.edit, isEdit: true, detail: fileDetail },
  MultiEdit: { icon: FilePenLine, color: TOOL_COLOR.edit, isEdit: true, detail: fileDetail },
  Write: { icon: FilePenLine, color: TOOL_COLOR.edit, isEdit: true, detail: fileDetail },
  NotebookEdit: { icon: FilePenLine, color: TOOL_COLOR.edit, detail: fileDetail },
  Read: { icon: FileText, color: TOOL_COLOR.read, detail: fileDetail },
  Grep: { icon: Search, color: TOOL_COLOR.read, detail: patternDetail },
  Glob: { icon: Search, color: TOOL_COLOR.read, detail: patternDetail },
  Bash: {
    icon: Terminal,
    color: TOOL_COLOR.run,
    detail: (o) => {
      const desc = asStr(o, 'description');
      if (desc) return `(${desc.slice(0, 60)})`;
      const cmd = asStr(o, 'command');
      return cmd ? `"${cmd.slice(0, 50)}"` : null;
    },
  },
  Task: { icon: Bot, color: TOOL_COLOR.run },
  Agent: { icon: Bot, color: TOOL_COLOR.agent },
  WebSearch: {
    icon: Globe,
    color: TOOL_COLOR.web,
    detail: (o) => {
      const q = asStr(o, 'query');
      return q ? `"${q.slice(0, 50)}"` : null;
    },
  },
  WebFetch: {
    icon: Globe,
    color: TOOL_COLOR.web,
    detail: (o) => {
      const u = asStr(o, 'url');
      return u ? u.slice(0, 60) : null;
    },
  },
  TodoWrite: { icon: ListChecks, color: TOOL_COLOR.other },
  TaskCreate: { icon: ListChecks, color: TOOL_COLOR.other },
  TaskUpdate: { icon: ListChecks, color: TOOL_COLOR.other },
  Skill: { icon: Puzzle, color: TOOL_COLOR.other },
};
const DEFAULT_TOOL_META: ToolMeta = { icon: Wrench, color: TOOL_COLOR.other };
export const toolMeta = (name: string): ToolMeta => TOOL_META[name] ?? DEFAULT_TOOL_META;

/** tool_use id → presentation info (lets a following tool_result show "which call this responds to").
 *  Built in the Reader data layer, so it's resolvable across scroll windows. */
export interface ToolRef {
  name: string;
  /** Call summary (file name / pattern / command) — shown in the tool_result label to identify the source of an out-of-order response */
  detail: string | null;
}
export function toolRefOf(name: string, input: unknown): ToolRef {
  return { name, detail: toolMeta(name).detail?.((input ?? {}) as Record<string, unknown>) ?? null };
}

/** Line-level unified diff in a single container: − red, + green, context gray. Relies on the outer FlatRow's single vertical scroll
 *  and inline wrapping, with no nested scroll bar (replaces the earlier two separately-scrolling before/after panes). */
function DiffView({ oldText, newText }: Readonly<{ oldText: string; newText: string }>) {
  const rows = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  return (
    <div className="overflow-hidden rounded border border-border bg-code-bg font-mono text-xs leading-relaxed">
      {rows.map((r, i) => {
        const nonAddColor = r.type === 'remove' ? 'text-red-600 dark:text-red-400' : 'opacity-30';
        const signColor = r.type === 'add' ? 'text-green-600 dark:text-green-400' : nonAddColor;
        const nonAddSign = r.type === 'remove' ? '−' : ' ';
        const signChar = r.type === 'add' ? '+' : nonAddSign;
        return (
        <div
          key={i}
          className={cn(
            'flex whitespace-pre-wrap break-all px-2',
            r.type === 'add' && 'bg-green-500/15 dark:bg-green-500/20',
            r.type === 'remove' && 'bg-red-500/15 dark:bg-red-500/20',
            r.type === 'context' && 'bg-code-bg'
          )}
        >
          <span className={cn('mr-1.5 shrink-0 select-none', signColor)}>
            {signChar}
          </span>
          <span className="min-w-0 flex-1">{r.text || ' '}</span>
        </div>
        );
      })}
    </div>
  );
}

/** Edit/MultiEdit/Write rendering: has both sides → line-level diff; Write (content only) → a plain content block. */
function EditToolView({ name, input }: Readonly<{ name: string; input: unknown }>) {
  const obj = (input ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown) => (typeof v === 'string' ? v : null);
  const filePath = asStr(obj.file_path);
  const pairs: { old: string | null; next: string | null }[] = [];
  if (name === 'MultiEdit' && Array.isArray(obj.edits)) {
    for (const e of obj.edits as Record<string, unknown>[]) pairs.push({ old: asStr(e?.old_string), next: asStr(e?.new_string) });
  } else if (name === 'Write') {
    pairs.push({ old: null, next: asStr(obj.content) });
  } else {
    pairs.push({ old: asStr(obj.old_string), next: asStr(obj.new_string) });
  }
  return (
    <div className="flex flex-col gap-2 font-sans">
      {filePath && (
        <div className="truncate text-micro text-muted-foreground" title={filePath}>
          {filePath}
        </div>
      )}
      {pairs.map((p, i) => {
        const fallbackContent = name === 'Write' && filePath ? (
          <pre
            className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-code-bg p-2 font-mono text-xs leading-relaxed"
            dangerouslySetInnerHTML={{ __html: highlightCode(p.next ?? '', filePath) }}
          />
        ) : (
          <div className="whitespace-pre-wrap break-all rounded border border-border bg-code-bg p-2 font-mono text-xs leading-relaxed">
            {p.next ?? p.old}
          </div>
        );
        return (
          <div key={i} className="flex flex-col gap-1">
            {pairs.length > 1 && <div className="text-micro font-semibold text-muted-foreground">Edit {i + 1}</div>}
            {p.old != null && p.next != null ? (
              <DiffView oldText={p.old} newText={p.next} />
            ) : (
              fallbackContent
            )}
          </div>
        );
      })}
    </div>
  );
}

/** AskUserQuestion's structured input → a question card (header label + question + options). */
interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
}

function parseAskQuestions(input: unknown): AskQuestion[] | null {
  const obj = (input ?? {}) as { questions?: unknown };
  if (!Array.isArray(obj.questions)) return null;
  const qs = obj.questions.filter(
    (q): q is AskQuestion =>
      !!q && typeof q === 'object' && typeof (q as AskQuestion).question === 'string' && Array.isArray((q as AskQuestion).options)
  );
  return qs.length > 0 ? qs : null;
}

function AskUserQuestionView({ questions }: Readonly<{ questions: AskQuestion[] }>) {
  return (
    <div className="flex flex-col gap-3 font-sans">
      {questions.map((q) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {q.header && (
              <span className="rounded-sm bg-accent px-1.5 py-0.5 text-micro font-semibold uppercase tracking-eyebrow text-muted-foreground">
                {q.header}
              </span>
            )}
            {q.multiSelect && <span className="text-micro text-muted-foreground">multi-select</span>}
          </div>
          <p className="text-xs font-medium text-foreground">{q.question}</p>
          <ul className="flex flex-col gap-1">
            {q.options.map((o) => (
              <li key={o.label} className="rounded-md border border-border bg-background/50 px-2 py-1.5">
                <div className="text-xs font-semibold text-foreground">{o.label}</div>
                {o.description && <div className="text-micro text-muted-foreground">{o.description}</div>}
                {o.preview && (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-code-bg p-1.5 font-mono text-micro leading-relaxed">
                    {o.preview}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** AskUserQuestion answers (tool_result) → question:choice mapping. Loose format: {answers:{Q:A}} or {Q:A}; returns null on parse failure to fall back to raw text. */
function parseAskAnswers(text: string): { question: string; answer: string }[] | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const src =
      obj && typeof obj === 'object' && obj.answers && typeof obj.answers === 'object'
        ? (obj.answers as Record<string, unknown>)
        : obj;
    if (!src || typeof src !== 'object') return null;
    const pairs = Object.entries(src)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([question, answer]) => ({ question, answer: String(answer) }));
    return pairs.length > 0 ? pairs : null;
  } catch {
    return null;
  }
}

function AskAnswerView({ pairs }: Readonly<{ pairs: { question: string; answer: string }[] }>) {
  return (
    <div className="flex flex-col gap-2 font-sans">
      {pairs.map((p) => (
        <div key={p.question} className="flex flex-col gap-0.5">
          <span className="text-micro text-muted-foreground">{p.question}</span>
          <span className="text-xs font-semibold text-foreground">{p.answer}</span>
        </div>
      ))}
    </div>
  );
}

function AgentLinkButton({ link, onOpenSubagent }: Readonly<{ link: AgentLink; onOpenSubagent: (id: string) => void }>) {
  if (!link.sessionId) return null;
  const target = link.sessionId;
  return (
    <Button
      variant="outline"
      size="sm"
      className="my-1 ml-6 h-auto max-w-[calc(100%-1.75rem)] items-start justify-start whitespace-normal break-words py-1 text-left leading-snug border-subagent/40 text-subagent hover:bg-subagent/10 [&>svg]:mt-0.5 [&>svg]:shrink-0"
      onClick={() => onOpenSubagent(target)}
    >
      <SquareArrowOutUpRight />
      <span className="min-w-0">Open subagent "{link.name ?? link.description ?? link.subagentType ?? 'unknown'}" transcript</span>
    </Button>
  );
}

function ToolUseBlock({ block, onOpenSubagent }: Readonly<{ block: Extract<Block, { kind: 'tool_use' }>; onOpenSubagent: (id: string) => void }>) {
  const meta = toolMeta(block.name);
  const Icon = meta.icon;
  const desc = block.agentLink ? (block.agentLink.description ?? block.agentLink.name ?? '') : '';
  const detail = desc ? `— ${desc}` : (meta.detail?.((block.input ?? {}) as Record<string, unknown>) ?? null);
  const toolLabelEl = (
    <>
      <span style={{ color: meta.color }}>{block.name}</span>
      {detail ? <span> {detail}</span> : null}
    </>
  );
  const source = truncate(JSON.stringify(block.input, null, 2) ?? '', INPUT_PREVIEW_MAX);
  const askQuestions = block.name === 'AskUserQuestion' ? parseAskQuestions(block.input) : null;
  const editOrSource = meta.isEdit ? (
    <StructuredView pretty={<EditToolView name={block.name} input={block.input} />} source={source} />
  ) : (
    source
  );
  return (
    <div>
      <FlatRow icon={Icon} toneClass="text-tool" accent={meta.color} label={toolLabelEl}>
        {askQuestions ? (
          <StructuredView pretty={<AskUserQuestionView questions={askQuestions} />} source={source} />
        ) : (
          editOrSource
        )}
      </FlatRow>
      {block.agentLink && <AgentLinkButton link={block.agentLink} onOpenSubagent={onOpenSubagent} />}
    </div>
  );
}

function ToolResultBlock({ block, toolNames }: Readonly<{ block: Extract<Block, { kind: 'tool_result' }>; toolNames: Map<string, ToolRef> }>) {
  const ref = toolNames.get(block.toolUseId);
  // Left-edge bar in the tool color pairs a result with its tool_use (identifying the source of an out-of-order response); errors always override with red
  const refColor = ref ? toolMeta(ref.name).color : undefined;
  const accent = block.isError ? undefined : refColor;
  const resultLabel = (
    <>
      {ref ? (
        <span style={{ color: toolMeta(ref.name).color }}>
          {ref.name}{ref.detail ? <span className="text-muted-foreground"> {ref.detail}</span> : null}{' '}
        </span>
      ) : null}
      {block.isError ? 'Tool error' : 'Tool result'} ({block.text.length.toLocaleString()} chars)
    </>
  );
  const askAnswers = ref?.name === 'AskUserQuestion' && !block.isError ? parseAskAnswers(block.text) : null;
  return (
    <div className="group/toolresult flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <FlatRow
          icon={block.isError ? CircleAlert : CornerDownLeft}
          toneClass={block.isError ? 'text-destructive' : 'text-muted-foreground'}
          accent={accent}
          label={resultLabel}
        >
          {askAnswers ? (
            <StructuredView pretty={<AskAnswerView pairs={askAnswers} />} source={truncate(block.text, RESULT_PREVIEW_MAX)} />
          ) : (
            truncate(block.text, RESULT_PREVIEW_MAX)
          )}
        </FlatRow>
      </div>
      {block.toolUseId && (
        <button
          type="button"
          className="mt-0.5 shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-primary group-hover/toolresult:opacity-100 [&_svg]:size-3"
          title="Jump to the call site"
          aria-label="Jump to call site"
          onClick={() => globalThis.dispatchEvent(new CustomEvent('recensa:locate-tool', { detail: block.toolUseId }))}
        >
          <CornerDownRight />
        </button>
      )}
    </div>
  );
}

function BlockView({ block, toolNames, onOpenSubagent }: Readonly<{ block: Block; toolNames: Map<string, ToolRef>; onOpenSubagent: (id: string) => void }>) {
  switch (block.kind) {
    case 'text':
      // text blocks are handled by MessageItem's card layer and never reach here
      return null;
    case 'thinking':
      return (
        <FlatRow icon={Brain} toneClass="text-thinking italic" accent="var(--thinking)" label={`Thinking (${block.text.length.toLocaleString()} chars)`}>
          {block.text}
        </FlatRow>
      );
    case 'tool_use':
      return <ToolUseBlock block={block} onOpenSubagent={onOpenSubagent} />;
    case 'tool_result':
      return <ToolResultBlock block={block} toolNames={toolNames} />;
    case 'image':
      return (
        <div className="my-1 ml-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageIcon className="size-3.5" />
          Image (not shown inline)
        </div>
      );
    case 'other':
      return <div className="ml-6 text-xs text-muted-foreground">[{block.type}]</div>;
    default:
      return null;
  }
}

/** Conversation card (human / assistant text) + any accompanying non-text blocks */
function ConversationCard({
  message,
  textBlocks,
  restBlocks,
  meta,
  onOpenSubagent,
  toolNameMap,
}: Readonly<{
  message: Message;
  textBlocks: TextBlock[];
  restBlocks: Block[];
  meta: string;
  onOpenSubagent: (id: string) => void;
  toolNameMap?: Map<string, ToolRef>;
}>) {
  const isHuman = message.origin === 'human';
  const isTeammate = message.origin === 'teammate';
  const nonHumanLabel = isTeammate ? (message.teammate?.id ?? 'Teammate') : 'Assistant';
  const senderLabel = isHuman ? 'You' : nonHumanLabel;
  const nonHumanIcon = isTeammate ? (
    <Users className="text-subagent" />
  ) : (
    <Bot className="text-subagent" />
  );
  return (
    <div>
      {textBlocks.length > 0 && (
        <article
          className={cn(
            'group relative rounded-lg border px-3.5 py-2.5',
            isHuman ? 'border-border border-l-[3px] border-l-secondary bg-card-user' : 'border-border bg-card'
          )}
        >
          <CopyButton text={textBlocks.map((b) => b.text).join('\n\n')} />
          <div className="mb-1 flex items-center gap-1.5 text-micro text-foreground/65 [&_svg]:size-3">
            {isHuman ? (
              <MessageSquareText className="text-secondary" />
            ) : (
              nonHumanIcon
            )}
            <span className="font-medium">{senderLabel}</span>
          </div>
          {(message.isApiError || message.attributionSkill || message.truncated) && (
            <div className="mb-1 flex flex-wrap items-center gap-2 text-micro">
              {message.isApiError && (
                <span className="inline-flex items-center gap-1 font-semibold text-destructive [&_svg]:size-3">
                  <CircleAlert />
                  API error response
                  {message.errorDetail && (message.errorDetail.status || message.errorDetail.message) && (
                    <span className="font-normal">
                      ({[message.errorDetail.status, message.errorDetail.message].filter(Boolean).join(' ')})
                    </span>
                  )}
                </span>
              )}
              {message.attributionSkill && (
                <span className="inline-flex items-center gap-1 rounded-sm bg-accent px-1.5 py-0.5 text-muted-foreground [&_svg]:size-3">
                  <Puzzle />
                  {message.attributionSkill}
                </span>
              )}
              {message.truncated && (
                <span className="inline-flex items-center gap-1 font-semibold text-primary [&_svg]:size-3">
                  <CircleAlert />
                  Response truncated (hit token limit)
                </span>
              )}
            </div>
          )}
          {textBlocks.map((b, i) => (
            <div
              key={`${message.uuid}:t${i}`}
              className="markdown text-sm"
              // content is sanitized with DOMPurify (lib/md.ts), not raw HTML injected directly
              dangerouslySetInnerHTML={{ __html: renderMarkdown(b.text) }}
            />
          ))}
          {meta && <footer className="mt-1.5 text-right font-mono text-micro text-muted-foreground/80">{meta}</footer>}
        </article>
      )}
      {restBlocks.map((block, i) => (
        <BlockView key={`${message.uuid}:${i}`} block={block} toolNames={toolNameMap ?? new Map()} onOpenSubagent={onOpenSubagent} />
      ))}
    </div>
  );
}

interface MessageItemProps {
  message: Message;
  onOpenSubagent: (sessionId: string) => void;
  focusMode?: boolean;
  /** Cross-message toolUseId→presentation-info lookup ref (the Reader data layer computes it once over all loaded messages, rather than filling it in during render) */
  toolNameMap?: { current: Map<string, ToolRef> };
}

/** Whether this message is hidden in noise-reduction (main-conversation) mode: keep only human/assistant/teammate messages that carry actual text.
 *  Reader uses this to skip rendering + strip the wrapper padding (so the virtualizer measures a true 0 height) and to skip it during j/k navigation. */
export function isHiddenInFocus(message: Message): boolean {
  if (message.origin !== 'human' && message.origin !== 'assistant' && message.origin !== 'teammate') return true;
  return !message.blocks.some((b) => b.kind === 'text' && b.text.trim() !== '');
}

/**
 * Rendering rules (modeled on mainstream coding-agent desktop apps):
 * - Only "conversation text" (human / assistant text) uses a card block
 * - thinking / tool_call / tool_result / injected messages → flat expandable rows
 * - Supplementary info (time · model · tokens) trails the card content in small type
 * This component only dispatches on origin; each form is handled by the sub-components above.
 */
export const MessageItem = memo(function MessageItem({ message, onOpenSubagent, focusMode, toolNameMap }: MessageItemProps) {
  const textBlocks = message.blocks.filter((b): b is TextBlock => b.kind === 'text');
  const restBlocks = focusMode ? [] : message.blocks.filter((b) => b.kind !== 'text');
  const meta = metaText(message);

  switch (message.origin) {
    case 'compact':
      return <CompactCard textBlocks={textBlocks} />;
    case 'away':
      return <AwayCard textBlocks={textBlocks} meta={meta} />;
    case 'queued':
      return <QueuedRow textBlocks={textBlocks} />;
    case 'command':
      return <CommandRow message={message} />;
    case 'system_event':
      return <SystemEventRow message={message} textBlocks={textBlocks} />;
    case 'hook':
      return <HookRow message={message} />;
    case 'boundary':
      return <BoundaryDivider ts={message.ts} />;
    case 'teammate':
      if (message.teammate) return <TeammateCard message={message} meta={meta} />;
      break;
    case 'injected':
    case 'meta': {
      const text = joinText(textBlocks);
      return (
        <FlatRow icon={Inbox} toneClass="text-muted-foreground" label={`System injection (${text.length.toLocaleString()} chars)`}>
          {text || 'No text content'}
        </FlatRow>
      );
    }
    default:
      break;
  }
  return (
    <ConversationCard
      message={message}
      textBlocks={textBlocks}
      restBlocks={restBlocks}
      meta={meta}
      onOpenSubagent={onOpenSubagent}
      toolNameMap={toolNameMap?.current}
    />
  );
});
