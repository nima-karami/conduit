import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isE2eIrrelevant,
  parseNameStatus,
  parseZeroContextDiff,
  selectAffected,
  withMapBuildHunks,
} from '../e2e/ci-affected.mjs';

/**
 * Line spans are 1-based and inclusive, in the coordinates of the map's build (`builtFrom`).
 *   webview/split.tsx: split-editor ran 10–20 (and a nested 14–16), explorer ran 30–40
 *   src/layout.ts:     split-editor and explorer both ran 5–9
 *   src/pty.ts:        cwd ran 1–50
 */
const map = {
  schema: 2,
  builtFrom: 'nightly',
  scenarios: {
    'split-editor': {
      builtFrom: 'nightly',
      files: {
        'webview/split.tsx': [
          [10, 20],
          [14, 16],
        ],
        'src/layout.ts': [[5, 9]],
      },
    },
    explorer: {
      builtFrom: 'nightly',
      files: { 'webview/split.tsx': [[30, 40]], 'src/layout.ts': [[5, 9]] },
    },
    cwd: { builtFrom: 'nightly', files: { 'src/pty.ts': [[1, 50]] } },
  },
};
const all = ['split-editor', 'explorer', 'cwd', 'session-bootstrap', 'quit-guard', 'fresh'];
const ctx = { map, all, core: ['session-bootstrap', 'quit-guard'], excluded: [] };
const CORE_AND_FRESH = ['fresh', 'quit-guard', 'session-bootstrap'];
type Hunk = { start: number; count: number };
const m = (path: string, status: 'A' | 'M' | 'D' = 'M', hunks?: Hunk[]) => ({
  path,
  status,
  ...(hunks ? { hunks } : {}),
});
const lines = (start: number, count = 1) => ({ start, count });
const insertAfter = (line: number) => ({ start: line, count: 0 });

describe('selectAffected: rule order', () => {
  it('only e2e-irrelevant changes → none', () => {
    const r = selectAffected(
      [
        m('test/unit/foo.test.ts'),
        m('docs/specs/x.md'),
        m('README.md'),
        m('webview/NOTES.md'),
        m('designs/a.pen'),
        m('.conduit/board.json'),
        m('.github/workflows/release.yml'),
      ],
      ctx,
    );
    expect(r).toEqual({ kind: 'none', names: [], reasons: ['only e2e-irrelevant files changed'] });
  });

  it.each([
    'test/e2e/harness.mjs',
    'test/e2e/fixtures/notes.md',
    'electron/main.ts',
    'electron/preload.ts',
    'esbuild.mjs',
    'package.json',
    'package-lock.json',
    '.github/workflows/e2e.yml',
  ])('%s → full, even beside irrelevant changes', (path) => {
    const r = selectAffected([m('docs/a.md'), m(path)], ctx);
    expect(r.kind).toBe('full');
    expect(r.names).toEqual([...all].sort());
    expect(r.reasons.join('\n')).toContain(path);
  });

  it('a Markdown file the app ships (resources/skills/*/SKILL.md) is not irrelevant → full', () => {
    const r = selectAffected([m('resources/skills/conduit-plan/SKILL.md', 'M', [lines(3)])], ctx);
    expect(r.kind).toBe('full');
    expect(r.reasons.join('\n')).toContain('resources/skills/conduit-plan/SKILL.md');
  });

  it('no coverage map, or one in the old file-level format → full', () => {
    const change = [m('webview/split.tsx', 'M', [lines(12)])];
    expect(selectAffected(change, { ...ctx, map: null }).kind).toBe('full');
    const old = { builtFrom: 'x', scenarios: { cwd: ['src/pty.ts'] } };
    expect(selectAffected(change, { ...ctx, map: old }).kind).toBe('full');
  });
});

describe('selectAffected: changed lines against credited function ranges', () => {
  it('a changed line inside a function selects every scenario that ran a range holding it', () => {
    const r = selectAffected([m('webview/split.tsx', 'M', [lines(15)])], ctx);
    expect(r.kind).toBe('names');
    expect(r.names).toEqual(['split-editor', ...CORE_AND_FRESH].sort());
    const both = selectAffected([m('src/layout.ts', 'M', [lines(6, 2)])], ctx);
    expect(both.names).toEqual(['explorer', 'split-editor', ...CORE_AND_FRESH].sort());
  });

  it('hunks in two credited functions select both', () => {
    const r = selectAffected([m('webview/split.tsx', 'M', [lines(18, 3), lines(35)])], ctx);
    expect(r.names).toEqual(['explorer', 'split-editor', ...CORE_AND_FRESH].sort());
  });

  it.each([
    ['top-level code before any function', [lines(3)]],
    ['a line between two credited functions', [lines(25)]],
    ['a hunk that runs off the end of a credited function', [lines(19, 4)]],
    ['a deletion/replacement past the last credited line', [lines(41, 2)]],
  ])('%s → full', (_why, hunks) => {
    const r = selectAffected([m('webview/split.tsx', 'M', hunks)], ctx);
    expect(r.kind).toBe('full');
    expect(r.reasons.join('\n')).toMatch(/webview\/split\.tsx:\d+/);
  });

  it('an insertion counts as inside a function only if both neighbouring base lines are', () => {
    expect(selectAffected([m('webview/split.tsx', 'M', [insertAfter(12)])], ctx).names).toContain(
      'split-editor',
    );
    // After a function's last line: new code between functions.
    expect(selectAffected([m('webview/split.tsx', 'M', [insertAfter(20)])], ctx).kind).toBe('full');
    // Before the first line of the file.
    expect(selectAffected([m('src/pty.ts', 'M', [insertAfter(0)])], ctx).kind).toBe('full');
  });

  it('a modified file with no credited range at all → full', () => {
    const r = selectAffected([m('src/unknown.ts', 'M', [lines(4)])], ctx);
    expect(r.kind).toBe('full');
    expect(r.reasons.join('\n')).toContain('src/unknown.ts');
  });

  it('a modified mapped file without a line diff against the map build → full', () => {
    const r = selectAffected([m('webview/split.tsx', 'M')], ctx);
    expect(r.kind).toBe('full');
    expect(r.reasons.join('\n')).toContain('webview/split.tsx');
  });

  it('a modified mapped file identical to the map build adds nothing, and says so', () => {
    const r = selectAffected([m('webview/split.tsx', 'M', [])], ctx);
    expect(r).toMatchObject({ kind: 'names', names: CORE_AND_FRESH });
    expect(r.reasons).toContain("webview/split.tsx: identical to the map's build");
  });

  it('the review case: top-level data (editor-menu.ts NAVIGATION) → full', () => {
    // NAVIGATION is a module-level array; only the functions that read it were ever credited.
    const menu = {
      ...map,
      scenarios: {
        ...map.scenarios,
        'nav-keybindings-settings': {
          builtFrom: 'nightly',
          files: { 'webview/editor-menu.ts': [[140, 175]] },
        },
      },
    };
    const r = selectAffected([m('webview/editor-menu.ts', 'M', [lines(76, 3)])], {
      ...ctx,
      all: [...all, 'nav-keybindings-settings'],
      map: menu,
    });
    expect(r.kind).toBe('full');
    expect(r.reasons.join('\n')).toContain('webview/editor-menu.ts:76');
  });
});

describe('selectAffected: added and deleted files', () => {
  it('a new code file → full (its code has no coverage yet)', () => {
    const r = selectAffected([m('webview/split-util.ts', 'A')], ctx);
    expect(r.kind).toBe('full');
    expect(r.reasons.join('\n')).toContain('webview/split-util.ts');
  });

  it('a deleted .ts/.tsx file selects every scenario that ran any of its functions', () => {
    expect(selectAffected([m('src/pty.ts', 'D')], ctx).names).toEqual(
      ['cwd', ...CORE_AND_FRESH].sort(),
    );
    expect(selectAffected([m('src/gone.ts', 'D')], ctx)).toMatchObject({
      kind: 'names',
      names: CORE_AND_FRESH,
    });
  });

  it.each(['webview/styles/app.css', 'resources/skills/x/SKILL.md', 'src/data.json'])(
    'a deleted unmapped non-.ts/.tsx file (%s) → full',
    (path) => {
      expect(selectAffected([m(path, 'D')], ctx).kind).toBe('full');
    },
  );
});

describe('selectAffected: the map itself', () => {
  it('drops map entries for scenarios that no longer exist (split or deleted)', () => {
    const stale = {
      ...map,
      scenarios: {
        ...map.scenarios,
        'split-editor-old': { builtFrom: 'nightly', files: { 'src/pty.ts': [[1, 50]] } },
      },
    };
    const r = selectAffected([m('src/pty.ts', 'M', [lines(3)])], { ...ctx, map: stale });
    expect(r.names).not.toContain('split-editor-old');
    expect(r.names).toContain('cwd');
  });

  it('a scenario the map has never seen always runs, unless it is excluded remotely', () => {
    expect(selectAffected([m('src/pty.ts', 'M', [lines(3)])], ctx).names).toContain('fresh');
    const r = selectAffected([m('src/pty.ts', 'M', [lines(3)])], { ...ctx, excluded: ['fresh'] });
    expect(r.names).not.toContain('fresh');
  });

  it('an entry kept from an older nightly always runs and credits nothing', () => {
    const older = {
      ...map,
      scenarios: {
        ...map.scenarios,
        explorer: { builtFrom: 'older', files: { 'webview/split.tsx': [[1, 100]] } },
      },
    };
    const inside = selectAffected([m('webview/split.tsx', 'M', [lines(15)])], {
      ...ctx,
      map: older,
    });
    expect(inside.names).toEqual(['explorer', 'split-editor', ...CORE_AND_FRESH].sort());
    expect(inside.reasons.join('\n')).toContain('older nightly');
    // Its span is in another build's line numbers, so it can't vouch for line 25.
    const outside = selectAffected([m('webview/split.tsx', 'M', [lines(25)])], {
      ...ctx,
      map: older,
    });
    expect(outside.kind).toBe('full');
  });
});

describe('isE2eIrrelevant', () => {
  it.each([
    ['test/unit/a.test.ts', true],
    ['docs/adr/0001.md', true],
    ['CHANGELOG.md', true],
    ['designs/x.pen', true],
    ['.conduit/plan.json', true],
    ['.github/workflows/verify.yml', true],
    ['.github/workflows/e2e.yml', false],
    ['webview/app.tsx', false],
    ['test/e2e/cwd.e2e.mjs', false],
    ['test/e2e/fixtures/doc.md', false],
    ['test/e2e/README.md', false],
    ['resources/skills/conduit-plan/SKILL.md', false],
  ])('%s → %s', (path, expected) => {
    expect(isE2eIrrelevant(path)).toBe(expected);
  });
});

describe('parseNameStatus', () => {
  it('reads git diff --name-status, a rename as a delete plus an add', () => {
    expect(
      parseNameStatus('M\tsrc/a.ts\nA\tsrc/b.ts\nR087\tsrc/old.ts\tsrc/new.ts\nD\tx.ts\n'),
    ).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'src/b.ts', status: 'A' },
      { path: 'src/old.ts', status: 'D' },
      { path: 'src/new.ts', status: 'A' },
      { path: 'x.ts', status: 'D' },
    ]);
  });
});

describe('parseZeroContextDiff', () => {
  it('reads the base-side hunks of `git diff -U0`, per file', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3 @@ export const x = 1;',
      '-a',
      '+b',
      '@@ -10,0 +11,2 @@',
      '+c',
      '+d',
      '@@ -20,3 +22 @@ function f() {',
      '-e',
      '-f',
      '-g',
      '+h',
      'diff --git a/webview/new file.ts b/webview/new file.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/webview/new file.ts\t',
      '@@ -0,0 +1 @@',
      '+x',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-y',
      '-z',
      '',
    ].join('\n');
    expect(parseZeroContextDiff(text)).toEqual({
      'src/a.ts': {
        absent: false,
        hunks: [
          { start: 3, count: 1 },
          { start: 10, count: 0 },
          { start: 20, count: 3 },
        ],
      },
      'webview/new file.ts': { absent: true, hunks: [{ start: 0, count: 0 }] },
      'src/gone.ts': { absent: false, hunks: [{ start: 1, count: 2 }] },
    });
  });

  it('a removed `-- ` or added `++ ` body line is content, not a file header', () => {
    const text = [
      'diff --git a/src/f.ts b/src/f.ts',
      'index 1111111..2222222 100644',
      '--- a/src/f.ts',
      '+++ b/src/f.ts',
      '@@ -4 +4 @@ export function f() {',
      '--- a',
      '+++ b',
      '@@ -8 +8 @@',
      '-export const bottom = 1;',
      '\\ No newline at end of file',
      '+export const bottom = 2;',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(parseZeroContextDiff(text)).toEqual({
      'src/f.ts': {
        absent: false,
        hunks: [
          { start: 4, count: 1 },
          { start: 8, count: 1 },
        ],
      },
    });
  });

  it('reads a C-quoted path', () => {
    const text = [
      'diff --git "a/src/t\\tb.ts" "b/src/t\\tb.ts"',
      '--- "a/src/t\\tb.ts"',
      '+++ "b/src/t\\tb.ts"',
      '@@ -2 +2 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    expect(parseZeroContextDiff(text)).toEqual({
      'src/t\tb.ts': { absent: false, hunks: [{ start: 2, count: 1 }] },
    });
  });
});

describe('withMapBuildHunks and the CLI, against a real git repo', () => {
  const CLI = join(__dirname, '..', 'e2e', 'ci-affected.mjs');
  let repo = '';
  let build = '';
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, encoding: 'utf8' },
    ).trim();
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const fBody = (inner: string, bottom: number) =>
    [
      'export const top = 1;',
      'export function f() {',
      '  const s = `',
      inner,
      '`;',
      '  return s;',
      '}',
      `export const bottom = ${bottom};`,
      '',
    ].join('\n');
  // Scenario `a` ran f (lines 2–7); line 8 is top-level code no scenario is credited with.
  const map = () => ({
    schema: 2,
    builtFrom: build,
    scenarios: {
      a: {
        builtFrom: build,
        files: { 'src/f.ts': [[2, 7]], 'src/g.ts': [[1, 3]], 'src/h.ts': [[1, 1]] },
      },
    },
  });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ci-affected-'));
    git('init', '-q');
    // Settings a developer may have: none of them may change what the parser reads.
    git('config', 'diff.noprefix', 'true');
    git('config', 'color.diff', 'always');
    git('config', 'core.autocrlf', 'false');
    for (const n of ['a', 'b', 'core']) put(`test/e2e/${n}.e2e.mjs`, '');
    put('test/e2e/core-smoke.json', '["core"]');
    put('test/e2e/remote-exclusions.json', '{}');
    put('src/f.ts', fBody('-- a', 1));
    put('src/g.ts', 'export function g() {\n  return 1;\n}\n');
    put('src/h.ts', 'export function h() {}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'map build');
    build = git('rev-parse', 'HEAD');
    // Line 4 `-- a` → `++ b` shows in the diff as `--- a` / `+++ b`; line 8 is top-level.
    put('src/f.ts', fBody('++ b', 2));
    git('update-index', '--chmod=+x', 'src/h.ts');
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('reads both hunks past `-- `/`++ ` body lines, whatever the diff config', () => {
    const [f] = withMapBuildHunks([{ path: 'src/f.ts', status: 'M' }], map(), repo);
    expect(f.hunks).toEqual([
      { start: 4, count: 1 },
      { start: 8, count: 1 },
    ]);
  });

  it('a file identical to the map build gets no hunks; one git lists but the parser missed gets none', () => {
    const [g, h] = withMapBuildHunks(
      [
        { path: 'src/g.ts', status: 'M' },
        { path: 'src/h.ts', status: 'M' },
      ],
      map(),
      repo,
    );
    expect(g.hunks).toEqual([]);
    // A mode-only change: `git diff --name-only` lists it, the -U0 diff has no hunk for it.
    expect(h.hunks).toBeUndefined();
  });

  it('the CLI selects the full suite for the change past the `-- ` line', () => {
    writeFileSync(join(repo, 'map.json'), JSON.stringify(map()));
    execFileSync(process.execPath, [CLI, build, 'map.json', 'out.json'], {
      cwd: repo,
      encoding: 'utf8',
    });
    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.kind).toBe('full');
    expect(out.reasons.join('\n')).toContain('src/f.ts:8');
  });
});
