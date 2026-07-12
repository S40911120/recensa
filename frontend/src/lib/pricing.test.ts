import { describe, expect, it } from 'vitest';

import { estimateCost, formatCost } from './pricing';

describe('estimateCost', () => {
  it('applies exact per-million input/output rates for a known model', () => {
    // opus: $15/M in, $75/M out → 1M in + 1M out = 15 + 75
    expect(estimateCost('claude-opus-4-8', 1_000_000, 1_000_000, 0)).toBeCloseTo(90);
  });

  it('adds cache-creation cost at 1.25x the input rate', () => {
    // sonnet: $3/M in → 2M in = 6; 1M cache-write = 3 * 1.25 = 3.75
    expect(estimateCost('claude-sonnet-5', 2_000_000, 0, 1_000_000)).toBeCloseTo(9.75);
  });

  it('resolves an unknown suffixed variant via longest-prefix match', () => {
    // 'claude-haiku-4-5-20260101' must match haiku-4-5 ($0.8/M), not haiku-4
    expect(estimateCost('claude-haiku-4-5-20260101', 1_000_000, 0, 0)).toBeCloseTo(0.8);
  });

  it('falls back to Sonnet pricing for a fully unknown model', () => {
    // gpt-4 → default { input: 3, output: 15 } → 1M in + 1M out = 18
    expect(estimateCost('gpt-4', 1_000_000, 1_000_000, 0)).toBeCloseTo(18);
  });

  it('falls back to default pricing when the model is null', () => {
    expect(estimateCost(null, 1_000_000, 0, 0)).toBeCloseTo(3);
  });
});

describe('formatCost', () => {
  it('renders a sub-cent cost as a "< $0.01" floor', () => {
    expect(formatCost(0.004)).toBe('< $0.01');
  });

  it('renders a normal cost with two decimals', () => {
    expect(formatCost(1.5)).toBe('$1.50');
  });

  it('renders exactly one cent (boundary of the floor) as $0.01', () => {
    expect(formatCost(0.005)).toBe('$0.01');
  });
});
