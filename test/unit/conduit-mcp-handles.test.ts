import { describe, expect, it } from 'vitest';
import {
  allocateHandle,
  parseHandleCounters,
  serializeHandleCounters,
  slugHandlePrefix,
} from '../../src/conduit-mcp/handles';

describe('slugHandlePrefix', () => {
  it.each([
    ['Cli:Claude__X', 'cli-claude-x'],
    ['claude', 'claude'],
    ['--Codex 2--', 'codex-2'],
    ['e2e-fake-mcp', 'e2e-fake-mcp'],
  ])('%s → %s', (id, want) => {
    expect(slugHandlePrefix(id)).toBe(want);
  });
});

describe('allocateHandle', () => {
  it('allocate never reuses', () => {
    const a = allocateHandle({ claude: 2 }, 'claude');
    expect(a.handle).toBe('claude-3');
    const b = allocateHandle(a.counters, 'claude');
    expect(b.handle).toBe('claude-4');
    expect(b.counters).toEqual({ claude: 4 });
  });

  it('a new prefix starts at 1 and leaves the input untouched', () => {
    const before = { claude: 2 };
    const r = allocateHandle(before, 'codex');
    expect(r.handle).toBe('codex-1');
    expect(r.counters).toEqual({ claude: 2, codex: 1 });
    expect(before).toEqual({ claude: 2 });
  });
});

describe('parse/serialize', () => {
  it('round-trips', () => {
    const c = { claude: 3, codex: 1 };
    expect(parseHandleCounters(serializeHandleCounters(c))).toEqual(c);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['undefined', undefined],
    ['an array', '[1,2]'],
    ['null', 'null'],
  ])('%s → {}', (_label, text) => {
    expect(parseHandleCounters(text)).toEqual({});
  });

  it('drops entries that are not non-negative integers', () => {
    expect(parseHandleCounters('{"claude":2,"bad":"x","neg":-1,"frac":1.5}')).toEqual({
      claude: 2,
    });
  });
});
