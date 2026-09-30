import { describe, expect, it } from 'vitest';
import {
  importersFromMetafile,
  isE2eIrrelevant,
  parseNameStatus,
  selectAffected,
} from '../e2e/ci-affected.mjs';

const map = {
  builtFrom: 'x',
  scenarios: {
    'split-editor': ['webview/split.tsx', 'src/layout.ts'],
    explorer: ['webview/tree.tsx', 'src/layout.ts'],
    cwd: ['src/pty.ts'],
  },
};
const importers = {
  'webview/split-util.ts': ['webview/split.tsx'],
  'webview/deep.ts': ['webview/split-util.ts'],
  'webview/orphan.ts': ['webview/nowhere.ts'],
};
const all = ['split-editor', 'explorer', 'cwd', 'session-bootstrap', 'quit-guard', 'fresh'];
const ctx = { map, importers, all, core: ['session-bootstrap', 'quit-guard'], excluded: [] };
const m = (path: string, status: 'A' | 'M' | 'D' = 'M') => ({ path, status });

describe('selectAffected', () => {
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
    'electron/main.ts',
    'electron/preload.ts',
    'esbuild.mjs',
    'package.json',
    'package-lock.json',
    '.github/workflows/e2e.yml',
  ])('%s → full', (path) => {
    const r = selectAffected([m('docs/a.md'), m(path)], ctx);
    expect(r.kind).toBe('full');
    expect(r.names).toEqual([...all].sort());
    expect(r.reasons.join('\n')).toContain(path);
  });

  it('a mapped file selects its scenarios plus the core set', () => {
    const r = selectAffected([m('webview/tree.tsx')], ctx);
    expect(r.kind).toBe('names');
    expect(r.names).toEqual(['explorer', 'fresh', 'quit-guard', 'session-bootstrap']);
  });

  it('a new file selects the scenarios of the nearest mapped importers', () => {
    expect(selectAffected([m('webview/split-util.ts', 'A')], ctx).names).toContain('split-editor');
    const deep = selectAffected([m('webview/deep.ts', 'A')], ctx);
    expect(deep.kind).toBe('names');
    expect(deep.names).toContain('split-editor');
    expect(deep.names).not.toContain('explorer');
  });

  it('a new file with no mapped importer → full', () => {
    expect(selectAffected([m('webview/orphan.ts', 'A')], ctx).kind).toBe('full');
    expect(selectAffected([m('webview/unimported.ts', 'A')], ctx).kind).toBe('full');
  });

  it('a modified file absent from the map → full', () => {
    const r = selectAffected([m('src/unknown.ts')], ctx);
    expect(r.kind).toBe('full');
    expect(r.reasons.join('\n')).toContain('src/unknown.ts');
  });

  it('a deleted file selects its mapped scenarios, or nothing', () => {
    expect(selectAffected([m('src/pty.ts', 'D')], ctx).names).toContain('cwd');
    expect(selectAffected([m('src/gone.ts', 'D')], ctx)).toMatchObject({
      kind: 'names',
      names: ['fresh', 'quit-guard', 'session-bootstrap'],
    });
  });

  it('a scenario the map has never seen always runs, unless it is excluded remotely', () => {
    expect(selectAffected([m('src/pty.ts')], ctx).names).toContain('fresh');
    const r = selectAffected([m('src/pty.ts')], { ...ctx, excluded: ['fresh'] });
    expect(r.names).not.toContain('fresh');
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

describe('importersFromMetafile', () => {
  it('inverts project imports and drops node_modules', () => {
    const meta = {
      inputs: {
        'webview/a.tsx': {
          imports: [{ path: 'webview/b.ts' }, { path: 'node_modules/react/index.js' }],
        },
        'webview/c.tsx': { imports: [{ path: 'webview/b.ts' }] },
        'webview/b.ts': { imports: [] },
        'node_modules/react/index.js': { imports: [{ path: 'webview/b.ts' }] },
      },
    };
    expect(importersFromMetafile(meta)).toEqual({
      'webview/b.ts': ['webview/a.tsx', 'webview/c.tsx'],
    });
  });
});
