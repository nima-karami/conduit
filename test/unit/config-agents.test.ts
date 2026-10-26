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
  const homeDir = path.join(dir, 'home');
  return { file, warn, homeDir, cfg: loadAgentsConfig(file, { homeDir, e2e, warn }) };
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
    });
    expect(cfg).toEqual({ defs: [], briefs: new Map() });
  });
});
