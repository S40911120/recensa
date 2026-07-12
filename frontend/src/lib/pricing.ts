/** Claude model pricing (USD per million tokens), mid-2026; for rough cost estimation only. Not real-time, not an exact quote. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
  'claude-haiku-4': { input: 0.8, output: 4 },
  'claude-fable-5': { input: 3, output: 15 },
};

const DEFAULT_PRICE = { input: 3, output: 15 }; // unknown model: conservatively fall back to Sonnet pricing

function lookup(model: string | null | undefined) {
  if (!model) return DEFAULT_PRICE;
  const key = model.toLowerCase();
  // Prefer an exact match; otherwise take the longest prefix match — independent of the
  // declaration order in PRICING (a first-hit scan would mismatch haiku-4-5 to haiku-4's price
  // if the keys were ever reordered).
  if (PRICING[key]) return PRICING[key];
  let best: { len: number; price: { input: number; output: number } } | null = null;
  for (const [k, v] of Object.entries(PRICING)) {
    if (key.startsWith(k) && (!best || k.length > best.len)) best = { len: k.length, price: v };
  }
  return best?.price ?? DEFAULT_PRICE;
}

/** Convert a session's token usage to an approximate USD cost */
export function estimateCost(model: string | null | undefined, tokensIn: number, tokensOut: number, cacheCreation: number): number {
  const p = lookup(model);
  const inCost = (tokensIn / 1e6) * p.input;
  const outCost = (tokensOut / 1e6) * p.output;
  // cache-write cost is roughly 1.25x the input price (per Anthropic)
  const ccCost = (cacheCreation / 1e6) * p.input * 1.25;
  return inCost + outCost + ccCost;
}

/** Format a cost as a human-readable string */
export function formatCost(usd: number): string {
  if (usd < 0.005) return '< $0.01';
  return `$${usd.toFixed(2)}`;
}
