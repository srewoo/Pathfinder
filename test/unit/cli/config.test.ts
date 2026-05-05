import { describe, it, expect } from 'vitest';
import { mergeOptions, parseShard, applyShard } from '../../../cli/src/config';

describe('parseShard', () => {
  it('given undefined when parsing then returns undefined', () => {
    expect(parseShard(undefined)).toBeUndefined();
  });

  it('given "1/4" when parsing then returns {current:1,total:4}', () => {
    expect(parseShard('1/4')).toEqual({ current: 1, total: 4 });
  });

  it('given "2 / 8" with whitespace when parsing then accepts', () => {
    expect(parseShard('2 / 8')).toEqual({ current: 2, total: 8 });
  });

  it('given current > total when parsing then throws', () => {
    expect(() => parseShard('5/4')).toThrow(/Invalid --shard/);
  });

  it('given malformed string when parsing then throws', () => {
    expect(() => parseShard('1-of-4')).toThrow(/Invalid --shard/);
  });

  it('given zero current when parsing then throws', () => {
    expect(() => parseShard('0/4')).toThrow(/Invalid --shard/);
  });
});

describe('applyShard', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `tc-${i}` }));

  it('given no shard when applying then returns all items', () => {
    expect(applyShard(items, undefined)).toEqual(items);
  });

  it('given 4 shards when applying then partitions deterministically and exhaustively', () => {
    const partitions = [1, 2, 3, 4].map((c) =>
      applyShard(items, { current: c, total: 4 }),
    );
    const total = partitions.flat();
    expect(total.length).toBe(items.length);
    // Every item appears in exactly one shard
    const ids = total.map((t) => t.id).sort();
    expect(new Set(ids).size).toBe(items.length);
  });

  it('given identical input when sharding twice then output is stable', () => {
    const a = applyShard(items, { current: 2, total: 4 });
    const b = applyShard(items, { current: 2, total: 4 });
    expect(a).toEqual(b);
  });

  it('given total=1 when applying then returns all', () => {
    expect(applyShard(items, { current: 1, total: 1 })).toEqual(items);
  });
});

describe('mergeOptions', () => {
  const baseConfig = { plans: './x.json' };

  it('given config only when merging then uses defaults', () => {
    const opts = mergeOptions(baseConfig, {});
    expect(opts.plans).toBe('./x.json');
    expect(opts.browser).toBe('chromium');
    expect(opts.headless).toBe(true);
    expect(opts.concurrency).toBe(1);
    expect(opts.retries).toBe(0);
  });

  it('given CLI flags when merging then overrides config', () => {
    const opts = mergeOptions(
      { ...baseConfig, browser: 'chromium', concurrency: 1 },
      { browser: 'webkit', concurrency: '8' },
    );
    expect(opts.browser).toBe('webkit');
    expect(opts.concurrency).toBe(8);
  });

  it('given missing plans in both when merging then throws', () => {
    expect(() => mergeOptions({}, {})).toThrow(/Missing plans file/);
  });

  it('given reporter CLI flag when merging then splits comma list', () => {
    const opts = mergeOptions(baseConfig, { reporter: 'html,junit,github' });
    expect(opts.reporters).toEqual(['html', 'junit', 'github']);
  });

  it('given no reporter on GHA env when merging then includes github', () => {
    const prev = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = 'true';
    try {
      const opts = mergeOptions(baseConfig, {});
      expect(opts.reporters).toContain('github');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prev;
    }
  });

  it('given shard flag when merging then parses', () => {
    const opts = mergeOptions(baseConfig, { shard: '1/3' });
    expect(opts.shard).toEqual({ current: 1, total: 3 });
  });

  it('given concurrency=0 when merging then clamps to 1', () => {
    const opts = mergeOptions(baseConfig, { concurrency: '0' });
    expect(opts.concurrency).toBe(1);
  });

  it('given negative retries when merging then clamps to 0', () => {
    const opts = mergeOptions(baseConfig, { retries: '-3' });
    expect(opts.retries).toBe(0);
  });
});
