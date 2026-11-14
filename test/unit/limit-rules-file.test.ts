import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLimitRulesSource } from '../../server/domain/limit-rules-file';
import { SERVER_FILE_VERSION } from '../../src/contracts/session-identity';
import { DEFAULT_LIMIT_RULES } from '../../src/limit-rules';

const USER_DATA = '/userdata';
const FILE = join(USER_DATA, 'limit-rules.json');

interface Watch {
  onEvent(event: string, filename: string | null): void;
  closed: boolean;
}

function harness(initial: string | null) {
  const files = new Map<string, string>();
  if (initial !== null) files.set(FILE, initial);
  const writes: string[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const onChange = vi.fn();
  const watches: Watch[] = [];
  const watchCalls: {
    dir: string;
    opts: object;
    log?: (message: string, error?: unknown) => void;
  }[] = [];
  const source = createLimitRulesSource({
    userData: USER_DATA,
    watchDirWhilePresent: (dir, opts, onEvent) => {
      watchCalls.push({ dir, opts, log: opts.log });
      const watch: Watch = { onEvent, closed: false };
      watches.push(watch);
      return {
        close() {
          watch.closed = true;
        },
      };
    },
    fs: {
      read: (p) => files.get(p) ?? null,
      writeAtomic: (p, data) => {
        writes.push(p);
        files.set(p, data);
      },
    },
    onChange,
    log: {
      info: (msg) => infos.push(msg),
      warn: (msg) => warnings.push(msg),
    },
  });
  return { source, files, writes, infos, warnings, onChange, watches, watchCalls };
}

const ruleIds = (rules: readonly { id: string }[]) => rules.map((r) => r.id);
const FRESH = JSON.stringify({
  version: 1,
  rules: [{ id: 'fresh', cli: 'codex', enabled: true, match: 'quota' }],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('limit rules file', () => {
  it('creates the file with the defaults once, on first run', () => {
    const h = harness(null);
    expect(h.writes).toEqual([FILE]);
    expect(JSON.parse(h.files.get(FILE) ?? '{}')).toEqual({
      version: 1,
      rules: DEFAULT_LIMIT_RULES,
    });
    expect(ruleIds(h.source.current().rules)).toEqual(ruleIds(DEFAULT_LIMIT_RULES));
    expect(h.writes).toHaveLength(1);
  });

  it('seeds the file with the registered version', () => {
    const h = harness(null);
    expect(JSON.parse(h.files.get(FILE) ?? '{}').version).toBe(
      SERVER_FILE_VERSION['limit-rules.json'],
    );
  });

  it('keeps a corrupt file untouched, serves the defaults and warns once', () => {
    const h = harness('{not json');
    expect(ruleIds(h.source.current().rules)).toEqual(ruleIds(DEFAULT_LIMIT_RULES));
    expect(h.files.get(FILE)).toBe('{not json');
    expect(h.writes).toEqual([]);
    expect(h.warnings).toHaveLength(1);
  });

  it('keeps a foreign-version file untouched and serves the defaults', () => {
    const h = harness(JSON.stringify({ version: 9, rules: [] }));
    expect(ruleIds(h.source.current().rules)).toEqual(ruleIds(DEFAULT_LIMIT_RULES));
    expect(h.files.get(FILE)).toBe(JSON.stringify({ version: 9, rules: [] }));
    expect(h.warnings).toHaveLength(1);
  });

  it('excludes an invalid rule with one warning and loads the others', () => {
    const blob = JSON.stringify({
      version: 1,
      rules: [
        { id: 'good', cli: 'claude', enabled: true, match: 'resets' },
        { id: 'bad', cli: 'claude', enabled: true, match: '(unclosed' },
      ],
    });
    const h = harness(blob);
    expect(ruleIds(h.source.current().rules)).toEqual(['good']);
    expect(h.warnings).toHaveLength(1);
    expect(h.files.get(FILE)).toBe(blob);
  });

  it('watches userData through the self-re-arming helper, with its logger wired', () => {
    const h = harness(null);
    expect(h.watchCalls).toHaveLength(1);
    expect(h.watchCalls[0]?.dir).toBe(USER_DATA);
    h.watchCalls[0]?.log?.('could not watch', new Error('EMFILE'));
    expect(h.warnings).toContain('could not watch');
  });

  it('reloads and calls onChange when limit-rules.json changes, after the debounce', () => {
    const h = harness(JSON.stringify({ version: 1, rules: [] }));
    h.files.set(FILE, FRESH);
    h.watches[0]?.onEvent('change', 'limit-rules.json');
    vi.advanceTimersByTime(249);
    expect(h.onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(ruleIds(h.source.current().rules)).toEqual(['fresh']);
  });

  it('reloads on a null-name event, which the helper emits after an unwatched gap', () => {
    const h = harness(JSON.stringify({ version: 1, rules: [] }));
    h.files.set(FILE, FRESH);
    h.watches[0]?.onEvent('rename', null);
    vi.advanceTimersByTime(250);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(ruleIds(h.source.current().rules)).toEqual(['fresh']);
  });

  it('ignores an event for an unrelated file', () => {
    const h = harness(JSON.stringify({ version: 1, rules: [] }));
    h.files.set(FILE, FRESH);
    h.watches[0]?.onEvent('change', 'other.json');
    vi.advanceTimersByTime(1000);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(ruleIds(h.source.current().rules)).toEqual([]);
  });

  it('keeps the current rules and logs one line when the file goes missing on reload', () => {
    const h = harness(FRESH);
    h.files.delete(FILE);
    h.writes.length = 0;
    h.watches[0]?.onEvent('rename', 'limit-rules.json');
    vi.advanceTimersByTime(250);
    expect(ruleIds(h.source.current().rules)).toEqual(['fresh']);
    expect(h.warnings).toHaveLength(1);
    expect(h.writes).toEqual([]);
    expect(h.onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the current rules on a reload that finds the file corrupt', () => {
    const h = harness(FRESH);
    h.files.set(FILE, '{not json');
    h.watches[0]?.onEvent('rename', 'limit-rules.json');
    vi.advanceTimersByTime(250);
    expect(ruleIds(h.source.current().rules)).toEqual(['fresh']);
    expect(h.warnings).toHaveLength(1);
  });

  it('warns about a newer version on its own line and leaves the file alone', () => {
    const newer = JSON.stringify({ version: 99, rules: [] });
    const h = harness(newer);
    expect(ruleIds(h.source.current().rules)).toEqual(ruleIds(DEFAULT_LIMIT_RULES));
    expect(h.files.get(FILE)).toBe(newer);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/newer/);
  });

  it('closes the helper handle on dispose', () => {
    const h = harness(null);
    h.source.dispose();
    expect(h.watches[0]?.closed).toBe(true);
  });
});
