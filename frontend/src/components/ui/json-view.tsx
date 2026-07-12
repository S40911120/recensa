import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/utils';

const DEFAULT_OPEN_DEPTH = 2;
const STRING_PREVIEW_MAX = 400;

function Primitive({ value }: Readonly<{ value: unknown }>) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  switch (typeof value) {
    case 'string': {
      const text = value.length > STRING_PREVIEW_MAX ? `${value.slice(0, STRING_PREVIEW_MAX)}…` : value;
      return <span className="whitespace-pre-wrap break-all text-secondary">&quot;{text}&quot;</span>;
    }
    case 'number':
      return <span className="text-tool">{String(value)}</span>;
    case 'boolean':
      return <span className="font-semibold text-primary">{String(value)}</span>;
    default: {
      if (typeof value === 'object') return <span className="text-muted-foreground">{JSON.stringify(value)}</span>;
      return <span className="text-muted-foreground">{String(value)}</span>;
    }
  }
}

function Node({ name, value, depth }: Readonly<{ name: string | null; value: unknown; depth: number }>) {
  const isObject = value !== null && typeof value === 'object';
  const [isOpen, setIsOpen] = useState(depth < DEFAULT_OPEN_DEPTH);

  if (!isObject) {
    return (
      <div className="flex gap-1.5 py-0.5" style={{ paddingLeft: depth * 14 }}>
        {name !== null && <span className="shrink-0 text-foreground/80">{name}:</span>}
        <Primitive value={value} />
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const label = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;

  if (entries.length === 0) {
    return (
      <div className="flex gap-1.5 py-0.5 text-muted-foreground" style={{ paddingLeft: depth * 14 }}>
        {name !== null && <span className="text-foreground/80">{name}:</span>}
        {Array.isArray(value) ? '[]' : '{}'}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-1 rounded-sm py-0.5 text-left hover:bg-accent/60"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
      >
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-150', isOpen && 'rotate-90')} />
        {name !== null && <span className="text-foreground/80">{name}:</span>}
        <span className="text-muted-foreground">{label}</span>
      </button>
      {isOpen && entries.map(([k, v]) => <Node key={k} name={k} value={v} depth={depth + 1} />)}
    </div>
  );
}

/** Generic collapsible JSON tree view (type-colored; structured display for machine output such as the intel dashboard) */
export function JsonView({ data }: Readonly<{ data: unknown }>) {
  return (
    <div className="font-mono text-xs leading-relaxed">
      <Node name={null} value={data} depth={0} />
    </div>
  );
}
