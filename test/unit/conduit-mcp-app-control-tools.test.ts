import { describe, expect, it } from 'vitest';
import {
  type AppControlHandlers,
  createAppControlHandlers,
  MAX_CLOSE_PATHS,
  MAX_URL_BYTES,
} from '../../src/conduit-mcp/app-control-tools';
import {
  ACT_RATE_PER_CALLER,
  type ControlCallContext,
  type ControlDeps,
  createControlHandlers,
  type PreparedCall,
  SHOW_RATE_PER_CALLER,
  type TargetSession,
} from '../../src/conduit-mcp/control-tools';
import type { GitCall, GitRun } from '../../src/conduit-mcp/git-refs';
import type { Move, Reach } from '../../src/conduit-mcp/tool-policy';
import type { Caller } from '../../src/conduit-mcp/tools';
import type { Result } from '../../src/conduit-mcp/types';
import type { McpUiAction, McpUiResult } from '../../src/conduit-mcp/ui-types';
import { PRETTY_FORMAT } from '../../src/git-history';
import type { SessionOpResult } from '../../src/session-ops';

const HOME = '/home/main';
const SHA = 'c'.repeat(40);

/** caller-1 and its peers: one it opened and one bystander in window 1, one in window 2. */
const TARGETS: TargetSession[] = [
  { sessionId: 'caller-1', handle: 'claude-1', openerSessionId: null },
  { sessionId: 'opened-1', handle: 'claude-2', openerSessionId: 'caller-1' },
  { sessionId: 'same-1', handle: 'codex-1', openerSessionId: null },
  { sessionId: 'other-1', handle: 'codex-2', openerSessionId: null },
];

function logRecord(sha: string, subject: string): string {
  const fmt = PRETTY_FORMAT.replace(/^format:/, '');
  return `${fmt
    .replace('%H', sha)
    .replace('%P', '')
    .replace('%D', '')
    .replace('%an', 'Ann')
    .replace('%ae', 'a@x')
    .replace('%at', '1700000000')
    .replace('%s', subject)
    .replace('%b', '')}\n`;
}

/** A repo at HOME with main, feature, tag v1 and a commit c1; /w/lib is an attached non-repo. */
const GIT_TABLE: Record<string, Partial<GitRun>> = {
  [`${HOME}|rev-parse --show-toplevel`]: { ok: true, stdout: `${HOME}\n` },
  [`${HOME}|rev-parse --symbolic-full-name v1`]: { ok: true, stdout: 'refs/tags/v1\n' },
  [`${HOME}|rev-parse --verify --quiet v1^{commit}`]: { ok: true, stdout: `${SHA}\n` },
  [`${HOME}|rev-parse --symbolic-full-name feature`]: { ok: true, stdout: 'refs/heads/feature\n' },
  [`${HOME}|rev-parse --verify --quiet feature^{commit}`]: { ok: true, stdout: `${SHA}\n` },
  [`${HOME}|rev-parse --verify --quiet c1^{commit}`]: { ok: true, stdout: `${SHA}\n` },
  // A branch literally named "working": only a range head may mean the working tree.
  [`${HOME}|rev-parse --symbolic-full-name working`]: { ok: true, stdout: 'refs/heads/working\n' },
  [`${HOME}|rev-parse --verify --quiet working^{commit}`]: { ok: true, stdout: `${SHA}\n` },
  [`${HOME}|log -1 --parents --decorate=full --pretty=${PRETTY_FORMAT} --end-of-options ${SHA}`]: {
    ok: true,
    stdout: logRecord(SHA, 'c1 subject'),
  },
};

interface Harness {
  deps: ControlDeps;
  targets: TargetSession[];
  windows: Map<string, number | null>;
  notReady: Set<number>;
  roots: Map<string, string[]>;
  addRoots: Array<{ id: string; path: string }>;
  addResult: (id: string, p: string) => SessionOpResult;
  activations: Array<{ id: string; raise: boolean }>;
  gitCalls: string[];
}

function harness(): Harness {
  const h = {
    targets: [...TARGETS],
    windows: new Map<string, number | null>([
      ['caller-1', 1],
      ['opened-1', 1],
      ['same-1', 1],
      ['other-1', 2],
    ]),
    notReady: new Set<number>(),
    roots: new Map<string, string[]>([['caller-1', ['/w/lib']]]),
    addRoots: [],
    addResult: () => ({ ok: true }),
    activations: [],
    gitCalls: [],
  } as unknown as Harness;
  const git: GitCall = async (cwd, args) => {
    const key = `${cwd}|${args.join(' ')}`;
    h.gitCalls.push(key);
    const hit = GIT_TABLE[key];
    return { ok: hit?.ok ?? false, stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '' };
  };
  h.deps = {
    homeOf: (id) => (h.targets.some((t) => t.sessionId === id) ? HOME : undefined),
    resolvePath: (home, p) => (p.startsWith('/') ? p : `${home}/${p}`),
    kindOf: async () => 'missing',
    agentIds: () => [],
    resolveCommand: () => undefined,
    openSession: async () => {
      throw new Error('not used');
    },
    openFile: async () => {
      throw new Error('not used');
    },
    claimHandle: () => null,
    now: () => 1_000_000,
    info: () => {},
    foldersOf: (id) =>
      h.targets.some((t) => t.sessionId === id)
        ? { home: HOME, roots: [...(h.roots.get(id) ?? [])] }
        : undefined,
    addRoot: async (id, p) => {
      h.addRoots.push({ id, path: p });
      const r = h.addResult(id, p);
      if (r.ok) h.roots.set(id, [...(h.roots.get(id) ?? []), p]);
      return r;
    },
    activateSession: (id, raise) => h.activations.push({ id, raise }),
    git,
    targets: () => h.targets,
    ownerWindowOf: (id) => h.windows.get(id) ?? null,
    windowReady: (w) => !h.notReady.has(w),
  };
  return h;
}

interface UiCall {
  w: number;
  routed: string;
  action: McpUiAction;
}
function context(
  o: { reach?: Reach; move?: Move; answer?: (a: McpUiAction) => Result<McpUiResult> } = {},
) {
  const calls: UiCall[] = [];
  const answer =
    o.answer ??
    ((a: McpUiAction): Result<McpUiResult> => {
      switch (a.kind) {
        case 'closeSession':
          return { ok: true, value: { kind: 'closeSession', ok: true } };
        case 'closeFiles':
          return {
            ok: true,
            value: { kind: 'closeFiles', closed: a.paths === 'all' ? [] : a.paths, skipped: [] },
          };
        default:
          return { ok: true, value: { kind: 'opened' } };
      }
    });
  const ctx: ControlCallContext = {
    move: o.move,
    reach: o.reach,
    ui: async (w, routed, action) => {
      calls.push({ w, routed, action });
      return answer(action);
    },
  };
  return { ctx, calls };
}

const caller = (n = 1): Caller => ({ handle: `claude-${n}`, sessionId: `caller-${n}` });
const code = <T>(r: Result<T>) => (r.ok ? 'ok' : r.error.code);
const ok = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const build = (h: Harness): AppControlHandlers =>
  createAppControlHandlers(h.deps, createControlHandlers(h.deps).prepared);
async function runIt<T>(p: Promise<Result<PreparedCall<T>>>): Promise<Result<T>> {
  const r = await p;
  return r.ok ? r.value.run() : r;
}

/** Proves earlier refusals were refunded: `app`'s full budget is still there, then spent. */
async function budgetIntact(app: AppControlHandlers, tool: 'act' | 'show') {
  const { ctx } = context({ reach: 'any' });
  const n = tool === 'act' ? ACT_RATE_PER_CALLER : SHOW_RATE_PER_CALLER;
  const next = (): Promise<Result<PreparedCall<unknown>>> =>
    tool === 'act'
      ? app.prepareCloseSession(caller(), { session: 'claude-2' }, ctx)
      : app.prepareOpenUrl(caller(), { url: 'http://x/' }, ctx);
  for (let i = 0; i < n; i++) ok(await next());
  expect(code(await next())).toBe('rate_limited');
}

describe('targets and reach', () => {
  it('target by handle, then id; unlisted → unknown_session, token refunded', async () => {
    const h = harness();
    const app = build(h);
    const { ctx, calls } = context({ reach: 'any' });
    ok(await runIt(app.prepareCloseSession(caller(), { session: 'codex-1' }, ctx)));
    ok(await runIt(app.prepareCloseSession(caller(), { session: 'other-1' }, ctx)));
    expect(calls.map((c) => c.action)).toEqual([
      { kind: 'closeSession', target: 'same-1' },
      { kind: 'closeSession', target: 'other-1' },
    ]);
    for (let i = 0; i < ACT_RATE_PER_CALLER + 2; i++) {
      const r = await app.prepareCloseSession(caller(), { session: 'nope-9' }, ctx);
      expect(code(r)).toBe('unknown_session');
      expect(r.ok ? '' : r.error.message).toBe('no session "nope-9" in list_sessions');
    }
    const fresh = harness();
    const fa = build(fresh);
    for (let i = 0; i < ACT_RATE_PER_CALLER + 2; i++)
      expect(code(await fa.prepareCloseSession(caller(), { session: 'nope' }, ctx))).toBe(
        'unknown_session',
      );
    await budgetIntact(fa, 'act');
  });

  it('reach', async () => {
    const who = ['caller-1', 'opened-1', 'same-1', 'other-1'];
    const allowed: Record<Reach, string[]> = {
      self: ['caller-1'],
      opened: ['caller-1', 'opened-1'],
      window: ['caller-1', 'opened-1', 'same-1'],
      any: who,
    };
    for (const reach of ['self', 'opened', 'window', 'any'] as const) {
      for (const target of who) {
        for (const tool of ['close', 'focus'] as const) {
          const h = harness();
          const app = build(h);
          const { ctx } = context({ reach, move: 'yes' });
          const r: Result<unknown> =
            tool === 'close'
              ? await app.prepareCloseSession(caller(), { session: target }, ctx)
              : await app.prepareFocusSession(caller(), { session: target }, ctx);
          const pass = allowed[reach].includes(target);
          expect([reach, target, tool, code(r)]).toEqual([
            reach,
            target,
            tool,
            pass ? 'ok' : 'out_of_reach',
          ]);
          if (!r.ok) {
            for (const t of TARGETS) {
              if (t.sessionId === 'caller-1') continue;
              expect(r.error.message).not.toContain(t.handle);
              expect(r.error.message).not.toContain(t.sessionId);
            }
          }
        }
      }
    }
  });

  it('attach_folder enforces reach on a named session and never takes any', async () => {
    const h = harness();
    const app = build(h);
    const self = context({ reach: 'self' }).ctx;
    expect(
      code(await app.prepareAttachFolder(caller(), { path: 'sub', session: 'claude-2' }, self)),
    ).toBe('out_of_reach');
    ok(await app.prepareAttachFolder(caller(), { path: 'sub' }, self));
    ok(await app.prepareAttachFolder(caller(), { path: 'sub', session: 'claude-1' }, self));
    const opened = context({ reach: 'opened' }).ctx;
    ok(await app.prepareAttachFolder(caller(), { path: 'sub', session: 'claude-2' }, opened));
    expect(
      code(await app.prepareAttachFolder(caller(), { path: 'sub', session: 'codex-1' }, opened)),
    ).toBe('out_of_reach');
    // attach_folder doesn't offer 'any': one reaching here anyway counts as the narrowest reach.
    const any = context({ reach: 'any' }).ctx;
    expect(
      code(await app.prepareAttachFolder(caller(), { path: 'sub', session: 'codex-2' }, any)),
    ).toBe('out_of_reach');
    const none = context({ reach: undefined }).ctx;
    expect(
      code(await app.prepareAttachFolder(caller(), { path: 'sub', session: 'claude-2' }, none)),
    ).toBe('out_of_reach');
  });

  it('a missing reach is the narrowest, never everything', async () => {
    const h = harness();
    const app = build(h);
    const { ctx } = context({ reach: undefined, move: 'yes' });
    expect(code(await app.prepareCloseSession(caller(), { session: 'codex-2' }, ctx))).toBe(
      'out_of_reach',
    );
    ok(await app.prepareCloseSession(caller(), { session: 'claude-1' }, ctx));
  });

  it('move no refuses focus_session', async () => {
    const h = harness();
    const app = build(h);
    const { ctx } = context({ reach: 'any', move: 'no' });
    for (let i = 0; i < SHOW_RATE_PER_CALLER + 2; i++) {
      const r = await app.prepareFocusSession(caller(), { session: 'claude-2' }, ctx);
      expect(code(r)).toBe('move_not_allowed');
      expect(r.ok ? '' : r.error.message).toBe(
        "focus_session is set to never switch the human's view",
      );
    }
    expect(h.activations).toEqual([]);
    await budgetIntact(app, 'show');
  });
});

describe('window routing', () => {
  const cases: [
    string,
    (app: AppControlHandlers, ctx: ControlCallContext) => Promise<Result<unknown>>,
    number,
  ][] = [
    ['close_session', (a, c) => a.prepareCloseSession(caller(), { session: 'codex-2' }, c), 2],
    ['close_files', (a, c) => a.prepareCloseFiles(caller(), { all: true }, c), 1],
    ['open_review', (a, c) => a.prepareOpenReview(caller(), { source: { kind: 'working' } }, c), 1],
    ['open_git_history', (a, c) => a.prepareOpenGitHistory(caller(), {}, c), 1],
    ['open_url', (a, c) => a.prepareOpenUrl(caller(), { url: 'http://x/' }, c), 1],
    ['focus_session', (a, c) => a.prepareFocusSession(caller(), { session: 'codex-2' }, c), 2],
  ];

  it('every UI-routed tool refuses a null or unready window with window_not_ready', async () => {
    for (const [name, prep, w] of cases) {
      for (const breakIt of ['null', 'unready'] as const) {
        const h = harness();
        if (breakIt === 'unready') h.notReady.add(w);
        else h.windows.set(w === 2 ? 'other-1' : 'caller-1', null);
        const { ctx, calls } = context({ reach: 'any', move: 'yes' });
        expect([name, breakIt, code(await prep(build(h), ctx))]).toEqual([
          name,
          breakIt,
          'window_not_ready',
        ]);
        expect(calls).toEqual([]);
      }
    }
  });

  it('routesUi is true for the five UI-routed tools only', async () => {
    const h = harness();
    const app = build(h);
    const { ctx } = context({ reach: 'any', move: 'yes' });
    const routes = async (p: Promise<Result<PreparedCall<unknown>>>) => ok(await p).routesUi;
    expect(await routes(app.prepareCloseSession(caller(), { session: 'codex-2' }, ctx))).toBe(true);
    expect(await routes(app.prepareCloseFiles(caller(), { all: true }, ctx))).toBe(true);
    expect(
      await routes(app.prepareOpenReview(caller(), { source: { kind: 'working' } }, ctx)),
    ).toBe(true);
    expect(await routes(app.prepareOpenGitHistory(caller(), {}, ctx))).toBe(true);
    expect(await routes(app.prepareOpenUrl(caller(), { url: 'http://x/' }, ctx))).toBe(true);
    expect(await routes(app.prepareFocusSession(caller(), { session: 'codex-2' }, ctx))).toBe(
      false,
    );
    expect(await routes(app.prepareAttachFolder(caller(), { path: 'sub' }, ctx))).toBe(false);
  });

  it('run re-checks: target unlisted, out of reach, or its window gone between prepare and run', async () => {
    const breaks: [string, (h: Harness) => void, string][] = [
      [
        'unlisted',
        (h) =>
          h.targets.splice(
            h.targets.findIndex((t) => t.sessionId === 'same-1'),
            1,
          ),
        'unknown_session',
      ],
      ['moved away', (h) => h.windows.set('same-1', 2), 'out_of_reach'],
      ['window gone', (h) => h.notReady.add(1), 'window_not_ready'],
    ];
    for (const [label, breakIt, want] of breaks) {
      for (const tool of ['close', 'focus', 'attach'] as const) {
        const h = harness();
        const app = build(h);
        const { ctx, calls } = context({ reach: 'window', move: 'yes' });
        const p = ok<PreparedCall<unknown>>(
          await (tool === 'close'
            ? app.prepareCloseSession(caller(), { session: 'codex-1' }, ctx)
            : tool === 'focus'
              ? app.prepareFocusSession(caller(), { session: 'codex-1' }, ctx)
              : app.prepareAttachFolder(caller(), { path: 'sub', session: 'codex-1' }, ctx)),
        );
        breakIt(h);
        const r = await (p.run() as Promise<Result<unknown>>);
        // attach_folder is host-side: a gone window doesn't stop it.
        const expected = tool === 'attach' && want === 'window_not_ready' ? 'ok' : want;
        expect([label, tool, code(r)]).toEqual([label, tool, expected]);
        if (expected !== 'ok') {
          expect(calls).toEqual([]);
          expect(h.activations).toEqual([]);
          expect(h.addRoots).toEqual([]);
          p.release();
        }
      }
    }
    // Refund: a re-check refusal leaves the act budget whole.
    const h = harness();
    const app = build(h);
    const { ctx } = context({ reach: 'window' });
    for (let i = 0; i < ACT_RATE_PER_CALLER + 2; i++) {
      const p = ok(await app.prepareCloseSession(caller(), { session: 'codex-1' }, ctx));
      h.windows.set('same-1', 2);
      expect(code(await p.run())).toBe('out_of_reach');
      h.windows.set('same-1', 1);
    }
    await budgetIntact(app, 'act');
  });

  it('the caller-routed tools re-check the caller window at run', async () => {
    const h = harness();
    const app = build(h);
    const { ctx, calls } = context();
    const p = ok(await app.prepareOpenUrl(caller(), { url: 'http://x/' }, ctx));
    h.notReady.add(1);
    expect(code(await p.run())).toBe('window_not_ready');
    expect(calls).toEqual([]);
  });
});

describe('close_session', () => {
  it('to a target in another window routes to that window with routedSessionId = target', async () => {
    const h = harness();
    const app = build(h);
    const { ctx, calls } = context({ reach: 'any' });
    const p = ok(await app.prepareCloseSession(caller(), { session: 'codex-2' }, ctx));
    expect(p.summary).toEqual({ tool: 'close_session', target: 'codex-2' });
    expect(await p.run()).toStrictEqual({ ok: true, value: { closed: 'other-1' } });
    expect(calls).toEqual([
      { w: 2, routed: 'other-1', action: { kind: 'closeSession', target: 'other-1' } },
    ]);
  });

  it('unsaved → unsaved_changes listing the paths; unknownSession and errors pass through', async () => {
    const h = harness();
    const app = build(h);
    const unsaved = context({
      reach: 'any',
      answer: () => ({
        ok: true,
        value: { kind: 'closeSession', ok: false, unsaved: ['/w/a.ts', '/w/b.ts'] },
      }),
    }).ctx;
    const r = await runIt(app.prepareCloseSession(caller(), { session: 'codex-2' }, unsaved));
    expect(code(r)).toBe('unsaved_changes');
    expect(r.ok ? '' : r.error.message).toBe('unsaved changes in:\n/w/a.ts\n/w/b.ts');
    const gone = context({
      reach: 'any',
      answer: () => ({ ok: true, value: { kind: 'unknownSession' } }),
    }).ctx;
    expect(code(await runIt(app.prepareCloseSession(caller(), { session: 'codex-2' }, gone)))).toBe(
      'unknown_session',
    );
    const timeout = context({
      reach: 'any',
      answer: () => ({
        ok: false,
        error: { code: 'ui_timeout', message: 't', retryable: false },
      }),
    }).ctx;
    expect(
      code(await runIt(app.prepareCloseSession(caller(), { session: 'codex-2' }, timeout))),
    ).toBe('ui_timeout');
  });

  it('ok → {closed}; a self close names the caller', async () => {
    const h = harness();
    const app = build(h);
    const { ctx, calls } = context({ reach: 'self' });
    expect(
      await runIt(app.prepareCloseSession(caller(), { session: 'claude-1' }, ctx)),
    ).toStrictEqual({
      ok: true,
      value: { closed: 'caller-1' },
    });
    expect(calls[0]).toEqual({
      w: 1,
      routed: 'caller-1',
      action: { kind: 'closeSession', target: 'caller-1' },
    });
  });

  it('invalid session args → invalid_args', async () => {
    const app = build(harness());
    const { ctx } = context({ reach: 'any' });
    for (const a of [
      {},
      { session: '' },
      { session: 7 },
      { session: 'x'.repeat(129) },
      { session: 'a', x: 1 },
      null,
    ])
      expect(code(await app.prepareCloseSession(caller(), a, ctx))).toBe('invalid_args');
  });
});

describe('focus_session', () => {
  it('raises only when the target window differs from the caller window', async () => {
    const h = harness();
    const app = build(h);
    const { ctx } = context({ reach: 'any', move: 'yes' });
    expect(
      await runIt(app.prepareFocusSession(caller(), { session: 'codex-2' }, ctx)),
    ).toStrictEqual({
      ok: true,
      value: { focused: 'other-1' },
    });
    ok(await runIt(app.prepareFocusSession(caller(), { session: 'codex-1' }, ctx)));
    expect(h.activations).toEqual([
      { id: 'other-1', raise: true },
      { id: 'same-1', raise: false },
    ]);
  });
});

describe('attach_folder', () => {
  it("resolves against the caller's home; is-home and duplicate succeed with roots unchanged", async () => {
    const h = harness();
    const app = build(h);
    const { ctx } = context({ reach: 'self' });
    const p = ok(await app.prepareAttachFolder(caller(), { path: 'sub' }, ctx));
    expect(p.summary).toEqual({ tool: 'attach_folder', path: `${HOME}/sub`, target: 'claude-1' });
    expect(await p.run()).toStrictEqual({
      ok: true,
      value: { attached: `${HOME}/sub`, session_id: 'caller-1', roots: ['/w/lib', `${HOME}/sub`] },
    });
    expect(h.addRoots).toEqual([{ id: 'caller-1', path: `${HOME}/sub` }]);
    for (const reason of ['is-home', 'duplicate'] as const) {
      h.addResult = () => ({ ok: false, reason });
      expect(await runIt(app.prepareAttachFolder(caller(), { path: '/w/lib' }, ctx))).toStrictEqual(
        {
          ok: true,
          value: { attached: '/w/lib', session_id: 'caller-1', roots: ['/w/lib', `${HOME}/sub`] },
        },
      );
    }
  });

  it('maps addRoot refusals; overlaps → attach_refused; not-found → path_missing', async () => {
    const want: [SessionOpResult, string][] = [
      [{ ok: false, reason: 'not-found' }, 'path_missing'],
      [{ ok: false, reason: 'not-a-directory' }, 'not_a_directory'],
      [{ ok: false, reason: 'invalid-path' }, 'invalid_args'],
      [{ ok: false, reason: 'unknown-session' }, 'unknown_session'],
      [{ ok: false, reason: 'overlaps' }, 'attach_refused'],
    ];
    for (const [result, c] of want) {
      const h = harness();
      h.addResult = () => result;
      const app = build(h);
      const r = await runIt(app.prepareAttachFolder(caller(), { path: '/x' }, context().ctx));
      expect([result, code(r)]).toEqual([result, c]);
      if (c === 'attach_refused')
        expect(r.ok ? '' : r.error.message).toBe("can't attach /x: overlaps");
    }
  });

  it('run failure refunds; success keeps (act)', async () => {
    const h = harness();
    h.addResult = () => ({ ok: false, reason: 'not-found' });
    const app = build(h);
    const { ctx } = context();
    for (let i = 0; i < ACT_RATE_PER_CALLER + 2; i++)
      expect(code(await runIt(app.prepareAttachFolder(caller(), { path: '/x' }, ctx)))).toBe(
        'path_missing',
      );
    h.addResult = () => ({ ok: true });
    for (let i = 0; i < ACT_RATE_PER_CALLER; i++)
      ok(await runIt(app.prepareAttachFolder(caller(), { path: `/x${i}` }, ctx)));
    expect(code(await app.prepareAttachFolder(caller(), { path: '/y' }, ctx))).toBe('rate_limited');
  });
});

describe('close_files', () => {
  it('needs exactly one of paths/all; 51 paths → invalid_args; relative paths resolved', async () => {
    const h = harness();
    const app = build(h);
    const { ctx, calls } = context();
    const bad = [
      {},
      { paths: ['a'], all: true },
      { all: false },
      { paths: [] },
      { paths: [''] },
      { paths: ['x'.repeat(4097)] },
      { paths: Array.from({ length: MAX_CLOSE_PATHS + 1 }, (_, i) => `f${i}`) },
      { paths: 'a' },
      { paths: ['a'], extra: 1 },
    ];
    for (const a of bad)
      expect([a, code(await app.prepareCloseFiles(caller(), a, ctx))]).toEqual([a, 'invalid_args']);
    const p = ok(await app.prepareCloseFiles(caller(), { paths: ['a.ts', '/abs/b.ts'] }, ctx));
    expect(p.summary).toEqual({ tool: 'close_files', count: 2, all: false });
    expect(ok(await p.run())).toStrictEqual({
      closed: [`${HOME}/a.ts`, '/abs/b.ts'],
      skipped: [],
    });
    const all = ok(await app.prepareCloseFiles(caller(), { all: true }, ctx));
    expect(all.summary).toEqual({ tool: 'close_files', count: 0, all: true });
    ok(await all.run());
    expect(calls).toEqual([
      {
        w: 1,
        routed: 'caller-1',
        action: { kind: 'closeFiles', paths: [`${HOME}/a.ts`, '/abs/b.ts'] },
      },
      { w: 1, routed: 'caller-1', action: { kind: 'closeFiles', paths: 'all' } },
    ]);
  });

  it('passes skipped and truncated through', async () => {
    const app = build(harness());
    const { ctx } = context({
      answer: () => ({
        ok: true,
        value: {
          kind: 'closeFiles',
          closed: [],
          skipped: [{ path: '/a', reason: 'unsaved' }],
          truncated: true,
        },
      }),
    });
    expect(ok(await runIt(app.prepareCloseFiles(caller(), { all: true }, ctx)))).toStrictEqual({
      closed: [],
      skipped: [{ path: '/a', reason: 'unsaved' }],
      truncated: true,
    });
  });
});

describe('open_review', () => {
  it('working default scope all; commit via lookupCommit; range classifies; working head; result endpoints', async () => {
    const h = harness();
    const app = build(h);
    const { ctx, calls } = context();
    const w = ok(await app.prepareOpenReview(caller(), { source: { kind: 'working' } }, ctx));
    expect(w.summary).toEqual({ tool: 'open_review', what: 'working' });
    expect(ok(await w.run())).toStrictEqual({
      opened: 'review',
      source: { kind: 'working', scope: 'all' },
    });
    const staged = ok(
      await runIt(
        app.prepareOpenReview(caller(), { source: { kind: 'working', scope: 'staged' } }, ctx),
      ),
    );
    expect(staged.source).toStrictEqual({ kind: 'working', scope: 'staged' });
    const c = ok(
      await app.prepareOpenReview(caller(), { source: { kind: 'commit', ref: 'c1' } }, ctx),
    );
    expect(c.summary).toEqual({ tool: 'open_review', what: SHA.slice(0, 7) });
    expect(ok(await c.run())).toStrictEqual({
      opened: 'review',
      source: { kind: 'commit', sha: SHA },
    });
    const r = ok(
      await app.prepareOpenReview(
        caller(),
        { source: { kind: 'range', base: 'v1', head: 'feature' } },
        ctx,
      ),
    );
    expect(r.summary).toEqual({ tool: 'open_review', what: 'v1…feature' });
    expect(ok(await r.run())).toStrictEqual({
      opened: 'review',
      source: {
        kind: 'range',
        base: { kind: 'tag', ref: 'v1' },
        head: { kind: 'branch', ref: 'feature' },
      },
    });
    const rw = ok(
      await runIt(
        app.prepareOpenReview(
          caller(),
          { source: { kind: 'range', base: 'v1', head: 'working' } },
          ctx,
        ),
      ),
    );
    expect(rw.source).toStrictEqual({
      kind: 'range',
      base: { kind: 'tag', ref: 'v1' },
      head: { kind: 'working' },
    });
    expect(calls.map((x) => x.action)).toEqual([
      { kind: 'openReview', source: { kind: 'working', scope: 'all', repoRoot: HOME } },
      { kind: 'openReview', source: { kind: 'working', scope: 'staged', repoRoot: HOME } },
      {
        kind: 'openReview',
        source: { kind: 'commit', sha: SHA, subject: 'c1 subject', repoRoot: HOME },
      },
      {
        kind: 'openReview',
        source: {
          kind: 'range',
          base: { kind: 'tag', ref: 'v1' },
          head: { kind: 'branch', ref: 'feature' },
          repoRoot: HOME,
        },
      },
      {
        kind: 'openReview',
        source: {
          kind: 'range',
          base: { kind: 'tag', ref: 'v1' },
          head: { kind: 'working' },
          repoRoot: HOME,
        },
      },
    ]);
  });

  it('bad refs, bad shapes and a repo outside home/roots', async () => {
    const h = harness();
    const app = build(h);
    const { ctx } = context();
    const cases: [unknown, string][] = [
      [{ source: { kind: 'range', base: 'working', head: 'v1' } }, 'bad_ref'],
      [{ source: { kind: 'range', base: '-x', head: 'v1' } }, 'bad_ref'],
      [{ source: { kind: 'commit', ref: 'nope' } }, 'bad_ref'],
      [{ source: { kind: 'commit' } }, 'invalid_args'],
      [{ source: { kind: 'working', ref: 'v1' } }, 'invalid_args'],
      [{ source: { kind: 'working', scope: 'some' } }, 'invalid_args'],
      [{ source: { kind: 'range', base: 'v1' } }, 'invalid_args'],
      [{ source: { kind: 'commit', ref: 'c1', scope: 'all' } }, 'invalid_args'],
      [{ source: { kind: 'tree' } }, 'invalid_args'],
      [{}, 'invalid_args'],
      [{ source: { kind: 'working' }, repo: '..' }, 'not_a_repo'],
      [{ source: { kind: 'working' }, repo: '/w/lib' }, 'not_a_repo'],
    ];
    for (const [a, want] of cases)
      expect([a, code(await app.prepareOpenReview(caller(), a, ctx))]).toEqual([a, want]);
    const outside = await app.prepareOpenReview(
      caller(),
      { source: { kind: 'working' }, repo: '/etc' },
      ctx,
    );
    expect(outside.ok ? '' : outside.error.message).toBe(
      'repo must be your home folder or an attached folder',
    );
    const workingBase = await app.prepareOpenReview(
      caller(),
      { source: { kind: 'range', base: 'working', head: 'v1' } },
      ctx,
    );
    expect(workingBase.ok ? '' : workingBase.error.message).toBe(
      '"working" is only allowed as a range head',
    );
    // /w/lib is attached but not a repo: git was asked, and said no.
    expect(h.gitCalls).toContain('/w/lib|rev-parse --show-toplevel');
  });
});

describe('open_git_history', () => {
  it('without ref → selected null; with ref → the looked-up sha', async () => {
    const h = harness();
    const app = build(h);
    const { ctx, calls } = context();
    const none = ok(await app.prepareOpenGitHistory(caller(), {}, ctx));
    expect(none.summary).toEqual({ tool: 'open_git_history', ref: null });
    expect(ok(await none.run())).toStrictEqual({ opened: 'git-history', selected: null });
    const at = ok(await app.prepareOpenGitHistory(caller(), { ref: 'v1' }, ctx));
    expect(at.summary).toEqual({ tool: 'open_git_history', ref: 'v1' });
    expect(ok(await at.run())).toStrictEqual({ opened: 'git-history', selected: SHA });
    expect(calls.map((c) => c.action)).toEqual([
      { kind: 'openGitHistory', repoRoot: HOME, commit: null },
      {
        kind: 'openGitHistory',
        repoRoot: HOME,
        commit: {
          sha: SHA,
          parents: [],
          refs: [],
          author: 'Ann',
          email: 'a@x',
          date: 1700000000,
          subject: 'c1 subject',
        },
      },
    ]);
    expect(code(await app.prepareOpenGitHistory(caller(), { ref: '--all' }, ctx))).toBe('bad_ref');
    expect(code(await app.prepareOpenGitHistory(caller(), { ref: 3 }, ctx))).toBe('invalid_args');
  });

  it('a throwing git (prepare) or a throwing run → open_failed, never a rejection; refunded', async () => {
    const h = harness();
    h.deps.git = async () => {
      throw new Error('spawn EINVAL');
    };
    const app = build(h);
    const { ctx } = context();
    for (let i = 0; i < SHOW_RATE_PER_CALLER + 2; i++) {
      const r = await app.prepareOpenGitHistory(caller(), { ref: 'v1' }, ctx);
      expect(code(r)).toBe('open_failed');
      expect(r.ok ? '' : r.error.message).toContain('spawn EINVAL');
    }
    await budgetIntact(app, 'show');
    const app2 = build(harness());
    const throwing: ControlCallContext = {
      move: undefined,
      reach: undefined,
      ui: async () => {
        throw new Error('send blew up');
      },
    };
    for (let i = 0; i < SHOW_RATE_PER_CALLER + 2; i++) {
      const r = await runIt(app2.prepareOpenGitHistory(caller(), {}, throwing));
      expect(code(r)).toBe('open_failed');
      expect(r.ok ? '' : r.error.message).toContain('send blew up');
    }
    await budgetIntact(app2, 'show');
  });
});

describe('open_url', () => {
  it('javascript:, file:, conduit-preview://t/x → bad_url; > 2048 bytes → invalid_args; localhost:5173 → http://localhost:5173/; focus defaults true', async () => {
    const h = harness();
    const app = build(h);
    const { ctx, calls } = context();
    for (const url of ['javascript:alert(1)', 'file:///c:/x', 'conduit-preview://t/x']) {
      const r = await app.prepareOpenUrl(caller(), { url }, ctx);
      expect([url, code(r)]).toEqual([url, 'bad_url']);
      expect(r.ok ? '' : r.error.message).toBe('only http and https URLs can be opened');
    }
    // 2049 UTF-8 bytes in fewer than 2048 code units.
    const long = `http://x/${'é'.repeat((MAX_URL_BYTES - 8) / 2)}`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(MAX_URL_BYTES);
    expect(code(await app.prepareOpenUrl(caller(), { url: long }, ctx))).toBe('invalid_args');
    // Under the cap as typed; percent-encoding triples each é past it.
    const grows = `http://x/${'é'.repeat(500)}`;
    expect(Buffer.byteLength(grows)).toBeLessThanOrEqual(MAX_URL_BYTES);
    expect(code(await app.prepareOpenUrl(caller(), { url: grows }, ctx))).toBe('invalid_args');
    for (const a of [{}, { url: 1 }, { url: 'http://x/', focus: 'no' }, { url: 'http://x/', y: 1 }])
      expect(code(await app.prepareOpenUrl(caller(), a, ctx))).toBe('invalid_args');
    const p = ok(await app.prepareOpenUrl(caller(), { url: 'localhost:5173' }, ctx));
    expect(p.summary).toEqual({ tool: 'open_url', url: 'http://localhost:5173/' });
    expect(ok(await p.run())).toStrictEqual({ opened: 'http://localhost:5173/' });
    ok(await runIt(app.prepareOpenUrl(caller(), { url: 'https://a.b/c', focus: false }, ctx)));
    expect(calls.map((c) => c.action)).toEqual([
      { kind: 'openUrl', url: 'http://localhost:5173/', focus: true },
      { kind: 'openUrl', url: 'https://a.b/c', focus: false },
    ]);
  });

  it('a renderer failed answer → open_failed with its message, for open and close tools', async () => {
    const failed = context({
      reach: 'any',
      answer: () => ({ ok: true, value: { kind: 'failed', message: 'step failed: boom' } }),
    }).ctx;
    const app = build(harness());
    const runs: Promise<Result<unknown>>[] = [
      runIt(app.prepareOpenUrl(caller(), { url: 'http://x/' }, failed)),
      runIt(app.prepareCloseFiles(caller(), { all: true }, failed)),
      runIt(app.prepareCloseSession(caller(), { session: 'claude-2' }, failed)),
    ];
    for (const r of await Promise.all(runs))
      expect(r.ok ? null : r.error).toMatchObject({
        code: 'open_failed',
        message: 'step failed: boom',
      });
  });

  it('run failure refunds; success keeps (show)', async () => {
    const h = harness();
    const app = build(h);
    const failing = context({
      answer: () => ({ ok: false, error: { code: 'ui_timeout', message: 't', retryable: false } }),
    }).ctx;
    for (let i = 0; i < SHOW_RATE_PER_CALLER + 2; i++)
      expect(code(await runIt(app.prepareOpenUrl(caller(), { url: 'http://x/' }, failing)))).toBe(
        'ui_timeout',
      );
    const { ctx } = context();
    for (let i = 0; i < SHOW_RATE_PER_CALLER; i++)
      ok(await runIt(app.prepareOpenUrl(caller(), { url: 'http://x/' }, ctx)));
    expect(code(await app.prepareOpenUrl(caller(), { url: 'http://x/' }, ctx))).toBe(
      'rate_limited',
    );
  });
});
