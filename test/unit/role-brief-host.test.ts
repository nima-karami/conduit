import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  briefKeepIds,
  createRoleBriefHost,
  parseBriefRequest,
  type RoleBriefHostDeps,
} from '../../electron/role-brief-host';
import { scopeFromSpawnArgs } from '../../src/agent-scope';
import type { HostPlatform } from '../../src/lsp-binary';
import type {
  AgentBriefSource,
  AgentDefinition,
  BriefRequest,
  BriefState,
  SpawnSpec,
} from '../../src/types';

const def = (id: string, command: string): AgentDefinition => ({
  id,
  label: id,
  command,
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});
const CLAUDE = def('cli:claude', 'claude');
const CODEX = def('cli:codex', 'codex');
const FAKE = def('e2e-fake-mcp', 'node');
const CMD = def('cli:cmd', 'cmd.exe');

const prompt = (f: string) => `Read your role brief at ${f} and follow it.`;
const BOM = String.fromCharCode(0xfeff);

let userData: string;
let sessions: Map<string, { id: string; brief?: BriefState }>;
let setBrief: ReturnType<typeof vi.fn>;
let n: number;
let log: RoleBriefHostDeps['log'];

function make(
  over: Partial<RoleBriefHostDeps> = {},
  agentBriefs: Map<string, AgentBriefSource> = new Map(),
) {
  return createRoleBriefHost({
    userData,
    agentBriefs,
    mgr: {
      get: (id: string) => sessions.get(id) as never,
      setBrief: setBrief as never,
      mintId: () => `s${++n}`,
    },
    platform: 'linux' as HostPlatform,
    e2e: true,
    log,
    ...over,
  });
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'role-brief-'));
  sessions = new Map();
  n = 0;
  setBrief = vi.fn((id: string, brief: BriefState | undefined) => {
    const s = sessions.get(id);
    if (!s) return false;
    if (brief === undefined) delete s.brief;
    else s.brief = brief;
    return true;
  });
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const store = () => path.join(userData, 'brief-store');
const canonical = (id: string) => path.join(store(), `${id}.md`);
const briefDir = (id: string) => path.join(userData, 'briefs', id);
const briefFile = (id: string) => path.join(briefDir(id), 'brief.md');

function create(
  host: ReturnType<typeof make>,
  d: AgentDefinition,
  request: BriefRequest | undefined,
  dialog = true,
) {
  const c = host.beginCreate({ def: d, request, dialog });
  if (!c.ok) throw new Error(`create failed: ${c.error}`);
  sessions.set(c.id, { id: c.id, ...(c.brief ? { brief: c.brief } : {}) });
  return c;
}

const spec = (args: string[] = [], command = 'claude'): SpawnSpec => ({
  command,
  args,
  cwd: userData,
});

const snapshot = () => {
  if (!fs.existsSync(store())) return {};
  return Object.fromEntries(
    fs.readdirSync(store()).map((f) => [f, fs.readFileSync(path.join(store(), f), 'utf8')]),
  );
};

describe('prepareSpawn', () => {
  it('AC2: claude gets --add-dir once and the prompt last, input untouched', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'be brief' });
    const input = [
      '--model',
      'opus',
      '--add-dir',
      '/r1',
      '--mcp-config',
      'f',
      '--allowedTools',
      'a,b',
    ];
    const frozen = [...input];
    const out = host.prepareSpawn(c.id, CLAUDE, spec(input));
    expect(out.spec.args.slice(-4)).toEqual([
      '--add-dir',
      briefDir(c.id),
      '--',
      prompt(briefFile(c.id)),
    ]);
    expect(out.spec.args.filter((a) => a === briefDir(c.id))).toHaveLength(1);
    expect(input).toEqual(frozen);
    expect(out.banners).toEqual([]);
  });

  it('AC3: codex and the fake read in place, with no --add-dir', () => {
    for (const d of [CODEX, FAKE]) {
      const host = make();
      const c = create(host, d, { kind: 'text', text: 'x' });
      const out = host.prepareSpawn(c.id, d, spec(['--a'], d.command));
      expect(out.spec.args).toEqual(['--a', '--', prompt(briefFile(c.id))]);
      expect(out.spec.args).not.toContain(briefDir(c.id));
    }
  });

  it('AC4: a batch-guarded launcher with % in userData drops the brief with a banner', () => {
    userData = path.join(userData, 'a%b');
    fs.mkdirSync(userData, { recursive: true });
    const host = make({ platform: 'win32' });
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    const input = ['--a'];
    const out = host.prepareSpawn(c.id, CLAUDE, spec(input, 'C:\\npm\\claude.cmd'));
    expect(out.spec.args).toEqual(input);
    expect(sessions.get(c.id)?.brief).toBeUndefined();
    expect(out.banners).toHaveLength(1);
    expect(out.banners[0]).toContain('path has "%"');
    expect(fs.existsSync(briefDir(c.id))).toBe(false);
  });

  it('AC5: pending commits to sent only when alive', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    host.prepareSpawn(c.id, CLAUDE, spec()).commit(false);
    expect(sessions.get(c.id)?.brief).toBe('pending');
    host.prepareSpawn(c.id, CLAUDE, spec()).commit(true);
    expect(sessions.get(c.id)?.brief).toBe('sent');
  });

  it('AC5: sent keeps the read flag, drops the prompt, and does not commit again', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    host.prepareSpawn(c.id, CLAUDE, spec()).commit(true);
    setBrief.mockClear();
    const out = host.prepareSpawn(c.id, CLAUDE, spec());
    expect(out.spec.args).toEqual(['--add-dir', briefDir(c.id)]);
    out.commit(true);
    expect(setBrief).not.toHaveBeenCalled();
  });

  it('AC5: a sent codex launch adds no args at all', () => {
    const host = make();
    const c = create(host, CODEX, { kind: 'text', text: 'x' });
    host.prepareSpawn(c.id, CODEX, spec([], 'codex')).commit(true);
    expect(host.prepareSpawn(c.id, CODEX, spec([], 'codex')).spec.args).toEqual([]);
  });

  it('AC5: pending with the canonical file gone clears with a "file missing" banner', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    fs.rmSync(canonical(c.id));
    const out = host.prepareSpawn(c.id, CLAUDE, spec(['--a']));
    expect(out.spec.args).toEqual(['--a']);
    expect(sessions.get(c.id)?.brief).toBeUndefined();
    expect(out.banners).toHaveLength(1);
    expect(out.banners[0]).toContain('file missing');
  });

  it('AC5: sent with the canonical file gone clears silently', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    host.prepareSpawn(c.id, CLAUDE, spec()).commit(true);
    fs.rmSync(canonical(c.id));
    const out = host.prepareSpawn(c.id, CLAUDE, spec());
    expect(out.banners).toEqual([]);
    expect(out.spec.args).toEqual([]);
    expect(sessions.get(c.id)?.brief).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('AC5: a restored stale session with a pending brief sends once', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    const restored = make();
    sessions.set(c.id, { id: c.id, brief: 'pending', status: 'stale' } as never);
    restored.prepareSpawn(c.id, CLAUDE, spec()).commit(true);
    expect(sessions.get(c.id)?.brief).toBe('sent');
    expect(restored.prepareSpawn(c.id, CLAUDE, spec()).spec.args).not.toContain('--');
  });

  it('AC6: the exposed dir is rebuilt from canonical every spawn', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'canon' });
    host.prepareSpawn(c.id, CLAUDE, spec());
    fs.writeFileSync(path.join(briefDir(c.id), 'CLAUDE.md'), 'planted');
    fs.writeFileSync(briefFile(c.id), 'edited');
    host.prepareSpawn(c.id, CLAUDE, spec());
    expect(fs.readdirSync(briefDir(c.id))).toEqual(['brief.md']);
    expect(fs.readFileSync(briefFile(c.id), 'utf8')).toBe('canon');
  });

  it('a rebuild failure adds no args, keeps the state, and banners', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    // A file where the parent `briefs` dir belongs makes the rebuild's mkdir throw.
    fs.writeFileSync(path.dirname(briefDir(c.id)), 'not a dir');
    const out = host.prepareSpawn(c.id, CLAUDE, spec(['--a']));
    expect(out.spec.args).toEqual(['--a']);
    expect(sessions.get(c.id)?.brief).toBe('pending');
    expect(out.banners[0]).toContain("couldn't prepare it");
    out.commit(true);
    expect(sessions.get(c.id)?.brief).toBe('pending');
  });

  it('a rebuild failure on a sent session is silent: nothing was owed', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    host.prepareSpawn(c.id, CLAUDE, spec()).commit(true);
    expect(sessions.get(c.id)?.brief).toBe('sent');
    fs.rmSync(path.dirname(briefDir(c.id)), { recursive: true, force: true });
    fs.writeFileSync(path.dirname(briefDir(c.id)), 'not a dir');
    const out = host.prepareSpawn(c.id, CLAUDE, spec(['--a']));
    expect(out.spec.args).toEqual(['--a']);
    expect(out.banners).toEqual([]);
    expect(sessions.get(c.id)?.brief).toBe('sent');
    expect(log.warn).toHaveBeenCalledWith('brief', 'brief rebuild failed', expect.anything());
  });

  it('AC2: the brief --add-dir is not a launched root when the scope is read before prepareSpawn', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    const input = spec(['--add-dir', path.resolve(userData, 'own')]);
    const folders = { home: userData, roots: [] };
    const before = scopeFromSpawnArgs(input.cwd, input.args, path.resolve, folders);
    const out = host.prepareSpawn(c.id, CLAUDE, input);
    const after = scopeFromSpawnArgs(out.spec.cwd, out.spec.args, path.resolve, folders);
    expect(before.dirs).toEqual([path.resolve(userData, 'own')]);
    expect(after.dirs).toContain(briefDir(c.id));
    expect(before.dirs).not.toContain(briefDir(c.id));
    expect(before.external).not.toContain(briefDir(c.id));
  });

  it('a launcher with no brief support is left alone', () => {
    const host = make();
    const out = host.prepareSpawn('nope', CMD, spec(['--a'], 'cmd.exe'));
    expect(out.spec.args).toEqual(['--a']);
    expect(out.banners).toEqual([]);
  });
});

describe('beginCreate', () => {
  it('AC7: strips a BOM and stores the rest verbatim', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: `${BOM}hello ` });
    expect(fs.readFileSync(canonical(c.id), 'utf8')).toBe('hello ');
    expect(c.brief).toBe('pending');
  });

  it('AC7: whitespace-only text means no brief and no file', () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: '  \n' });
    expect(c.brief).toBeUndefined();
    expect(fs.existsSync(store())).toBe(false);
  });

  it('AC7: an oversize file is refused and nothing is written', () => {
    const big = path.join(userData, 'big.md');
    fs.writeFileSync(big, 'a'.repeat(65_537));
    const r = make().beginCreate({
      def: CLAUDE,
      request: { kind: 'file', path: big },
      dialog: true,
    });
    expect(r).toEqual({ ok: false, error: 'brief-too-large' });
    expect(fs.existsSync(store()) ? fs.readdirSync(store()) : []).toEqual([]);
  });

  it('AC7: a file brief is snapshotted at creation', () => {
    const f = path.join(userData, 'b.md');
    fs.writeFileSync(f, 'v1');
    const c = create(make(), CLAUDE, { kind: 'file', path: f });
    fs.writeFileSync(f, 'v2');
    expect(fs.readFileSync(canonical(c.id), 'utf8')).toBe('v1');
  });

  it('AC7: rollback deletes the canonical file', () => {
    const c = create(make(), CLAUDE, { kind: 'text', text: 'x' });
    expect(fs.existsSync(canonical(c.id))).toBe(true);
    c.rollback();
    expect(fs.existsSync(canonical(c.id))).toBe(false);
  });

  it('AC8: the canonical file exists when creation returns ok', () => {
    const c = create(make(), CLAUDE, { kind: 'text', text: 'x' });
    expect(fs.existsSync(canonical(c.id))).toBe(true);
  });

  it('AC8: a silent creation with an unreadable agent file banners at the first spawn', () => {
    const host = make(
      {},
      new Map([[CLAUDE.id, { kind: 'file', path: path.join(userData, 'nope.md') }]]),
    );
    const c = create(host, CLAUDE, undefined, false);
    expect(c.brief).toBeUndefined();
    const out = host.prepareSpawn(c.id, CLAUDE, spec(['--a']));
    expect(out.spec.args).toEqual(['--a']);
    expect(out.banners).toHaveLength(1);
    expect(out.banners[0]).toContain("can't read the file");
    expect(host.prepareSpawn(c.id, CLAUDE, spec()).banners).toEqual([]);
  });

  it('a dialog creation with an unreadable file fails without writing', () => {
    const r = make().beginCreate({
      def: CLAUDE,
      request: { kind: 'file', path: path.join(userData, 'nope.md') },
      dialog: true,
    });
    expect(r).toEqual({ ok: false, error: 'brief-unreadable' });
  });

  it('request agent uses the agent brief text; none and unsupported launchers skip it', () => {
    const host = make({}, new Map([[CLAUDE.id, { kind: 'text', text: 'from agent' }]]));
    const c = create(host, CLAUDE, { kind: 'agent' });
    expect(fs.readFileSync(canonical(c.id), 'utf8')).toBe('from agent');
    expect(create(host, CLAUDE, { kind: 'none' }).brief).toBeUndefined();
    expect(create(host, CMD, { kind: 'text', text: 'x' }).brief).toBeUndefined();
  });
});

describe('beginDuplicate', () => {
  it('AC9: copies the canonical text, not what an agent edited in the exposed copy', () => {
    const host = make();
    const src = create(host, CLAUDE, { kind: 'text', text: 'canon' });
    host.prepareSpawn(src.id, CLAUDE, spec()).commit(true);
    fs.writeFileSync(briefFile(src.id), 'edited');
    const d = host.beginDuplicate(src.id);
    expect(d.brief).toBe('pending');
    expect(fs.readFileSync(canonical(d.id), 'utf8')).toBe('canon');
  });

  it('AC9: a source without a brief duplicates without one', () => {
    const host = make();
    const src = create(host, CLAUDE, { kind: 'none' });
    expect(host.beginDuplicate(src.id).brief).toBeUndefined();
  });

  it('AC9: a missing source canonical yields no brief and a copy-failed banner', () => {
    const host = make();
    const src = create(host, CLAUDE, { kind: 'text', text: 'x' });
    fs.rmSync(canonical(src.id));
    const d = host.beginDuplicate(src.id);
    expect(d.brief).toBeUndefined();
    sessions.set(d.id, { id: d.id });
    const out = host.prepareSpawn(d.id, CLAUDE, spec());
    expect(out.banners[0]).toContain("couldn't copy it from the original");
  });
});

describe('delete and sweep', () => {
  it('AC10: onSessionDeleted removes both paths', async () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    host.prepareSpawn(c.id, CLAUDE, spec());
    await host.onSessionDeleted(c.id);
    expect(fs.existsSync(canonical(c.id))).toBe(false);
    expect(fs.existsSync(briefDir(c.id))).toBe(false);
  });

  it('AC10: sweep keeps listed ids and removes the rest', () => {
    const host = make();
    const a = create(host, CLAUDE, { kind: 'text', text: 'a' });
    const b = create(host, CLAUDE, { kind: 'text', text: 'b' });
    host.prepareSpawn(a.id, CLAUDE, spec());
    host.prepareSpawn(b.id, CLAUDE, spec());
    host.sweep(new Set([a.id]));
    expect(fs.existsSync(canonical(a.id))).toBe(true);
    expect(fs.existsSync(briefDir(a.id))).toBe(true);
    expect(fs.existsSync(canonical(b.id))).toBe(false);
    expect(fs.existsSync(briefDir(b.id))).toBe(false);
  });

  it('sweep with no dirs on disk is silent', () => {
    make().sweep(new Set());
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a dot-only id never resolves to a path outside the brief dirs', async () => {
    const host = make();
    sessions.set('..', { id: '..', brief: 'pending' });
    host.prepareSpawn('..', CLAUDE, spec());
    await host.onSessionDeleted('..');
    expect(fs.existsSync(userData)).toBe(true);
  });

  it('empty and non-string ids never resolve to the brief roots', async () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    host.prepareSpawn(c.id, CLAUDE, spec());
    for (const bad of ['', undefined as unknown as string]) {
      sessions.set(bad, { id: bad, brief: 'pending' });
      const out = host.prepareSpawn(bad, CLAUDE, spec(['--a']));
      expect(out.spec.args).toEqual(['--a']);
      await host.onSessionDeleted(bad);
      expect(() => host.sweep(new Set([bad, c.id]))).not.toThrow();
    }
    expect(fs.existsSync(canonical(c.id))).toBe(true);
    expect(fs.existsSync(briefDir(c.id))).toBe(true);
    expect(fs.existsSync(path.join(userData, 'briefs'))).toBe(true);
  });

  it('canonical is only written by beginCreate and beginDuplicate', async () => {
    const host = make();
    const c = create(host, CLAUDE, { kind: 'text', text: 'x' });
    const before = snapshot();
    host.prepareSpawn(c.id, CLAUDE, spec()).commit(true);
    await host.probe(canonical(c.id));
    await host.agentPreview(CLAUDE);
    host.sweep(new Set([c.id]));
    expect(snapshot()).toEqual(before);
  });
});

describe('parseBriefRequest', () => {
  const abs = path.resolve('role.md');
  it('accepts the four well-formed kinds', () => {
    expect(parseBriefRequest({ kind: 'agent' })).toEqual({ kind: 'agent' });
    expect(parseBriefRequest({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(parseBriefRequest({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' });
    expect(parseBriefRequest({ kind: 'file', path: abs })).toEqual({ kind: 'file', path: abs });
  });

  it('rejects malformed input instead of passing it to the filesystem', () => {
    for (const bad of [
      undefined,
      null,
      'file',
      3,
      {},
      { kind: 'other' },
      { kind: 'file', path: 3 },
      { kind: 'file', path: 'relative/role.md' },
      { kind: 'file' },
      { kind: 'text', text: {} },
      { kind: 'text' },
    ]) {
      expect(parseBriefRequest(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('drops fields the kind does not own', () => {
    expect(parseBriefRequest({ kind: 'none', path: 3, text: {} })).toEqual({ kind: 'none' });
  });
});

describe('briefKeepIds', () => {
  it('is the union of live and on-disk ids, with restore on or off', () => {
    const live = [{ id: 'a' }, { id: 'b' }];
    const disk = [{ id: 'b' }, { id: 'c' }];
    expect([...briefKeepIds(live, disk)].sort()).toEqual(['a', 'b', 'c']);
    expect([...briefKeepIds([], disk)].sort()).toEqual(['b', 'c']);
    expect([...briefKeepIds(live, [])].sort()).toEqual(['a', 'b']);
  });

  it('skips ids that cannot name a brief file', () => {
    const ids = briefKeepIds([{ id: '' }, { id: undefined as unknown as string }], [{ id: 'x' }]);
    expect([...ids]).toEqual(['x']);
  });
});

describe('probe and agentPreview', () => {
  it('probe refuses a non-string or relative path', async () => {
    const host = make();
    expect(await host.probe(3)).toEqual({ ok: false, error: 'brief-unreadable' });
    expect(await host.probe(undefined)).toEqual({ ok: false, error: 'brief-unreadable' });
    // Exists relative to the cwd, so only the absolute-path guard can refuse it.
    expect(await host.probe('package.json')).toEqual({ ok: false, error: 'brief-unreadable' });
  });

  it('probe maps read, size and decode failures and counts trimmed bytes', async () => {
    const host = make();
    const f = path.join(userData, 'p.md');
    expect(await host.probe(f)).toEqual({ ok: false, error: 'brief-unreadable' });
    fs.writeFileSync(f, ' é ');
    expect(await host.probe(f)).toEqual({ ok: true, bytes: 2 });
    fs.writeFileSync(f, '   ');
    expect(await host.probe(f)).toEqual({ ok: true, bytes: 0 });
    fs.writeFileSync(f, 'a'.repeat(65_537));
    expect(await host.probe(f)).toEqual({ ok: false, error: 'brief-too-large' });
    fs.writeFileSync(f, Buffer.from([0xff, 0xfe, 0xfd]));
    expect(await host.probe(f)).toEqual({ ok: false, error: 'brief-invalid' });
  });

  it('agentPreview reports support, first line and file path', async () => {
    const f = path.join(userData, 'role.md');
    fs.writeFileSync(f, `\n\n  ${'x'.repeat(200)}\nsecond`);
    const host = make(
      {},
      new Map<string, AgentBriefSource>([
        [CLAUDE.id, { kind: 'text', text: '\n  Be terse.  \nmore' }],
        [CODEX.id, { kind: 'file', path: f }],
        [FAKE.id, { kind: 'file', path: path.join(userData, 'gone.md') }],
      ]),
    );
    expect(await host.agentPreview(CLAUDE)).toEqual({
      supported: true,
      has: true,
      firstLine: 'Be terse.',
    });
    expect(await host.agentPreview(CODEX)).toEqual({
      supported: true,
      has: true,
      path: f,
      firstLine: 'x'.repeat(120),
    });
    expect(await host.agentPreview(FAKE)).toEqual({
      supported: true,
      has: true,
      path: path.join(userData, 'gone.md'),
      error: 'brief-unreadable',
    });
  });

  it('agentPreview: a whitespace-only agent brief is no brief', async () => {
    const f = path.join(userData, 'blank.md');
    fs.writeFileSync(f, ' \n\t\n');
    const host = make(
      {},
      new Map<string, AgentBriefSource>([
        [CLAUDE.id, { kind: 'text', text: '  \n ' }],
        [CODEX.id, { kind: 'file', path: f }],
      ]),
    );
    expect(await host.agentPreview(CLAUDE)).toEqual({ supported: true, has: false });
    expect(await host.agentPreview(CODEX)).toEqual({ supported: true, has: false });
  });

  it('agentPreview: unsupported launcher and unknown agent', async () => {
    const host = make();
    expect(await host.agentPreview(CMD)).toEqual({ supported: false, has: false });
    expect(await host.agentPreview(undefined)).toEqual({ supported: false, has: false });
    expect(await host.agentPreview(CLAUDE)).toEqual({ supported: true, has: false });
  });
});
