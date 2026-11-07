import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentsConfig } from '../../src/config';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-agents-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const def = (over: Record<string, unknown>) => ({
  id: 'a',
  label: 'A',
  command: 'claude',
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
  ...over,
});

function load(raw: string, e2e = false) {
  const file = path.join(dir, 'agents.json');
  fs.writeFileSync(file, raw);
  const warn = vi.fn();
  const error = vi.fn();
  const homeDir = path.join(dir, 'home');
  return { file, warn, homeDir, cfg: loadAgentsConfig(file, { homeDir, e2e, warn, error }) };
}

describe('loadAgentsConfig', () => {
  it('text brief goes to the host map and is stripped from the def', () => {
    const { cfg, warn } = load(JSON.stringify([def({ brief: 'x' })]));
    expect(cfg.briefs.get('a')).toEqual({ kind: 'text', text: 'x' });
    expect('brief' in cfg.defs[0]).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a file brief resolves next to the agents file', () => {
    const { cfg, file } = load(JSON.stringify([def({ brief: { file: 'b.md' } })]));
    expect(cfg.briefs.get('a')).toEqual({
      kind: 'file',
      path: path.resolve(path.dirname(file), 'b.md'),
    });
  });

  it('a ~/ file brief resolves under the home dir', () => {
    const { cfg, homeDir } = load(JSON.stringify([def({ brief: { file: '~/b.md' } })]));
    expect(cfg.briefs.get('a')).toEqual({ kind: 'file', path: path.resolve(homeDir, 'b.md') });
  });

  it('an invalid shape keeps the def, drops the brief and warns once', () => {
    const { cfg, warn } = load(JSON.stringify([def({ brief: {} })]));
    expect(cfg.defs).toHaveLength(1);
    expect(cfg.briefs.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('agent brief ignored: invalid shape', { id: 'a' });
  });

  it('a launcher that takes no brief ignores it with one warn', () => {
    const { cfg, warn } = load(JSON.stringify([def({ command: 'aider', brief: 'x' })]));
    expect(cfg.defs).toHaveLength(1);
    expect('brief' in cfg.defs[0]).toBe(false);
    expect(cfg.briefs.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('agent brief ignored: launcher takes no brief', {
      id: 'a',
    });
  });

  it('the e2e fake takes a brief only in e2e mode', () => {
    const raw = JSON.stringify([def({ id: 'e2e-fake-mcp', command: 'node', brief: 'x' })]);
    expect(load(raw, true).cfg.briefs.size).toBe(1);
    expect(load(raw, false).cfg.briefs.size).toBe(0);
  });

  it('malformed or empty or missing files give an empty config', () => {
    for (const raw of ['{nope', '[]', '{}']) {
      const { cfg } = load(raw);
      expect(cfg.defs).toEqual([]);
      expect(cfg.briefs.size).toBe(0);
    }
    const cfg = loadAgentsConfig(path.join(dir, 'absent.json'), {
      homeDir: dir,
      e2e: false,
      warn: () => {},
      error: () => {},
    });
    expect(cfg).toEqual({ defs: [], briefs: new Map() });
  });
});

describe('loadAgentsConfig per-entry validation (flexible-agent-contracts §4.4)', () => {
  it('a bad entry is dropped with one warning and the others are kept', () => {
    const { cfg, warn } = load(
      JSON.stringify([def({ id: 'good' }), def({ id: 'bad', command: '' }), def({ id: 'ok' })]),
    );
    expect(cfg.defs.map((d) => d.id)).toEqual(['good', 'ok']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('the first of two duplicate ids wins, and the second is dropped with a warning', () => {
    const { cfg, warn } = load(
      JSON.stringify([def({ id: 'a', label: 'first' }), def({ id: 'a', label: 'second' })]),
    );
    expect(cfg.defs).toEqual([expect.objectContaining({ id: 'a', label: 'first' })]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a reserved cli: id', { id: 'cli:claude' }],
    ['a reserved shell: id', { id: 'shell:x' }],
    ['a reserved conduit: id', { id: 'conduit:x' }],
    ['a command with a leading dash', { command: '-x' }],
    ['a command with a NUL', { command: 'x\u0000' }],
    ['a whitespace-only command', { command: '   ' }],
    ['a non-string label', { label: 7 }],
    ['args that are not strings', { args: [1] }],
  ])('%s → dropped', (_label, over) => {
    const { cfg, warn } = load(JSON.stringify([def(over)]));
    expect(cfg.defs).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('missing args → [] and missing label → the id', () => {
    const { cfg, warn } = load(JSON.stringify([{ id: 'kiro', command: 'kiro' }]));
    expect(cfg.defs).toEqual([expect.objectContaining({ id: 'kiro', label: 'kiro', args: [] })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('capabilities.model_flag is kept when valid, dropped with a warning when not', () => {
    const ok = load(JSON.stringify([def({ capabilities: { model_flag: '--model' } })]));
    expect(ok.cfg.defs[0].capabilities).toEqual({ model_flag: '--model' });
    expect(ok.warn).not.toHaveBeenCalled();

    for (const flag of ['model', '--mo del', '-', '--a;b', 3]) {
      const bad = load(JSON.stringify([def({ capabilities: { model_flag: flag } })]));
      expect(bad.cfg.defs).toHaveLength(1);
      expect(bad.cfg.defs[0].capabilities?.model_flag).toBeUndefined();
      expect(bad.warn).toHaveBeenCalledTimes(1);
    }
  });

  it('more than 200 entries keeps the first 200 and warns once', () => {
    const many = Array.from({ length: 201 }, (_, i) => def({ id: `a${i}` }));
    const { cfg, warn } = load(JSON.stringify(many));
    expect(cfg.defs).toHaveLength(200);
    expect(cfg.defs[199].id).toBe('a199');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a parse error keeps the last good set and logs an error', () => {
    const file = path.join(dir, 'agents.json');
    const warn = vi.fn();
    const error = vi.fn();
    const opts = { homeDir: path.join(dir, 'home'), e2e: false, warn, error };
    fs.writeFileSync(file, JSON.stringify([def({ id: 'kept' })]));
    const first = loadAgentsConfig(file, opts);
    fs.writeFileSync(file, '{nope');
    const second = loadAgentsConfig(file, { ...opts, last: first });
    expect(second.defs.map((d) => d.id)).toEqual(['kept']);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a parse error with no earlier set is empty', () => {
    const { cfg } = load('{nope');
    expect(cfg.defs).toEqual([]);
  });
});
