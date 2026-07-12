export type DiffRow = { type: 'context' | 'add' | 'remove'; text: string };

const MAX_LINES = 1200;

/** Line-level unified diff (LCS): returns every line (all context/add/remove) for a faithful display */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length + b.length > MAX_LINES) {
    return [...a.map((t): DiffRow => ({ type: 'remove', text: t })), ...b.map((t): DiffRow => ({ type: 'add', text: t }))];
  }
  const m = a.length, n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'context', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'remove', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < m) out.push({ type: 'remove', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}
