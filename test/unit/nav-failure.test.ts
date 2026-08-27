/**
 * A navigation is never silent, even when the machinery under it fails — spec contract 3,
 * docs/specs/2026-08-21-goto-definition-flows.md.
 *
 * `runNavCommand`'s callers all `void` its promise, so an escaping rejection reaches nobody.
 * The reachable ones are real: monaco's TS mode rejects with a bare STRING ("TypeScript not
 * registered!") until it is set up — which is precisely the window flow row 39 fires in — and
 * an editor whose tab closes mid-flight throws from the message path instead.
 *
 * Only the three modules that reach into monaco's own internals are stubbed. `ts-project`,
 * `project-index`, `toast-store` and `monaco-message` run for real, so what these cases assert
 * is the message the user would actually get.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showNavMessage } from '../../webview/monaco-message';
import { gotoInflight } from '../../webview/monaco-warmup';
import { setDefinitionOpener } from '../../webview/project-index';
import {
  __resetToastsForTest,
  getToastsSnapshot,
  subscribeToasts,
} from '../../webview/toast-store';
import { runNavCommand } from '../../webview/ts-nav';

// vi.mock factories are hoisted above the imports, so the state they close over has to be
// hoisted with them. extraLibs stands in for the worker's extraLib map, which is where a
// navigation target's content lives when no tab is open on it.
const { getTypeScriptWorker, extraLibs } = vi.hoisted(() => ({
  getTypeScriptWorker: vi.fn(),
  extraLibs: {} as Record<string, { content: string; version: number }>,
}));

vi.mock('monaco-editor', () => ({
  Uri: { parse: (s: string) => ({ toString: () => s, path: s }) },
  Range: { lift: (r: unknown) => ({ ...(r as object), containsPosition: () => false }) },
  editor: {
    getModel: () => null,
    createModel: (content: string, _lang: string, uri: unknown) => ({
      uri,
      getValue: () => content,
      getPositionAt: () => ({ lineNumber: 1, column: 1 }),
    }),
  },
  languages: {},
  typescript: {
    getTypeScriptWorker: () => getTypeScriptWorker(),
    getJavaScriptWorker: () => getTypeScriptWorker(),
    typescriptDefaults: { getExtraLibs: () => extraLibs },
  },
}));
// 40+ real basic-language grammars, none of which a failure case reaches.
vi.mock('../../webview/monaco-languages', () => ({ ensureTokenizer: () => {} }));
vi.mock('../../webview/monaco-commands', () => ({ executeCommandWithArgs: vi.fn() }));

/** Enough editor for the failure paths: a TS model, a cursor, no contributions. */
function fakeEditor(over: Record<string, unknown> = {}) {
  const model = {
    uri: { toString: () => 'file:///g%3A/p/a.ts', path: '/g:/p/a.ts' },
    getLanguageId: () => 'typescript',
    getOffsetAt: () => 0,
    getPositionAt: () => ({ lineNumber: 1, column: 1 }),
    getWordAtPosition: () => ({ word: 'foo', startColumn: 1, endColumn: 4 }),
    getVersionId: () => 1,
    isDisposed: () => false,
  };
  return {
    focus: () => {},
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getContribution: () => undefined,
    setPosition: () => {},
    revealRangeInCenter: () => {},
    ...over,
  } as never;
}

describe('runNavCommand never throws and never goes quiet', () => {
  beforeEach(() => {
    __resetToastsForTest();
    getTypeScriptWorker.mockReset();
  });

  it('a worker that rejects with a bare string reports instead of escaping', async () => {
    getTypeScriptWorker.mockRejectedValue('TypeScript not registered!');
    const outcome = await runNavCommand(fakeEditor(), 'editor.action.revealDefinition');
    expect(outcome).toEqual({ kind: 'timed-out' });
    expect(getToastsSnapshot().map((t) => t.message)).toEqual([
      'Couldn’t resolve in time. Try again.',
    ]);
  });

  it('a worker that rejects with an Error reports too', async () => {
    getTypeScriptWorker.mockRejectedValue(new Error('worker gone'));
    await expect(runNavCommand(fakeEditor(), 'editor.action.goToReferences')).resolves.toEqual({
      kind: 'timed-out',
    });
  });

  it('leaves the in-flight indicator balanced after a failure', async () => {
    getTypeScriptWorker.mockRejectedValue('TypeScript not registered!');
    await runNavCommand(fakeEditor(), 'editor.action.revealDefinition');
    expect(gotoInflight.active()).toBe(false);
  });

  it('reports even when the editor itself is falling apart', async () => {
    getTypeScriptWorker.mockRejectedValue('TypeScript not registered!');
    const dying = fakeEditor({
      getContribution: () => {
        throw new Error('disposed');
      },
    });
    await expect(runNavCommand(dying, 'editor.action.revealDefinition')).resolves.toEqual({
      kind: 'timed-out',
    });
    expect(getToastsSnapshot()).toHaveLength(1);
  });

  it('an unclassifiable command id is a no-op, not a crash', async () => {
    await expect(runNavCommand(fakeEditor(), 'editor.action.formatDocument')).resolves.toEqual({
      kind: 'none',
    });
    expect(gotoInflight.active()).toBe(false);
  });
});

describe('showNavMessage always delivers the text', () => {
  beforeEach(() => __resetToastsForTest());

  it('falls back to the toast when the inline contribution throws', () => {
    const editor = fakeEditor({
      getContribution: () => {
        throw new Error('disposed');
      },
    });
    showNavMessage(editor, {
      text: 'No definition for ‘foo’ here',
      channel: 'inline',
      variant: 'info',
    });
    expect(getToastsSnapshot().map((t) => t.message)).toEqual(['No definition for ‘foo’ here']);
  });

  it('falls back to the toast when there is no contribution at all', () => {
    showNavMessage(fakeEditor(), {
      text: 'Nothing to navigate to here',
      channel: 'inline',
      variant: 'info',
    });
    expect(getToastsSnapshot()).toHaveLength(1);
  });

  it('uses the inline widget when one is available', () => {
    const shown: string[] = [];
    const editor = fakeEditor({
      getContribution: () => ({ showMessage: (m: string) => shown.push(m) }),
    });
    showNavMessage(editor, { text: 'inline please', channel: 'inline', variant: 'info' });
    expect(shown).toEqual(['inline please']);
    expect(getToastsSnapshot()).toHaveLength(0);
  });

  it('subscribers see the fallback toast', () => {
    const seen: number[] = [];
    const off = subscribeToasts(() => seen.push(getToastsSnapshot().length));
    showNavMessage(fakeEditor(), { text: 'x', channel: 'toast', variant: 'error' });
    off();
    expect(seen).toEqual([1]);
  });
});

describe('a diagnostics probe that hangs never degrades into a navigation (review 1)', () => {
  // A DIFFERENT file from the one on screen — a lone alias can live in a barrel, and that is
  // also the case that exercises the cross-file opener rather than an in-place cursor move.
  const TARGET = 'file:///g%3A/p/barrel.ts';
  const SOURCE = `import { z } from 'zod';\nexport const use = z;\n`;
  /** One result, and it is the import ALIAS — the shape that used to jump the caret onto the
   *  import clause of a package that was never indexed. */
  const aliasEntry = {
    fileName: TARGET,
    kind: 'alias',
    textSpan: { start: SOURCE.indexOf('z }'), length: 1 },
  };
  let opened: string[];

  beforeEach(() => {
    __resetToastsForTest();
    getTypeScriptWorker.mockReset();
    extraLibs[TARGET] = { content: SOURCE, version: 1 };
    opened = [];
    setDefinitionOpener((p) => opened.push(p));
  });

  const workerWith = (getSemanticDiagnostics: () => Promise<unknown>) => {
    const worker = {
      getDefinitionAtPosition: async () => [aliasEntry],
      getSemanticDiagnostics,
    };
    getTypeScriptWorker.mockResolvedValue(() => Promise.resolve(worker));
  };

  it('reports instead of navigating when the type-check never answers', async () => {
    workerWith(() => new Promise(() => {}));
    const started = Date.now();
    const outcome = await runNavCommand(fakeEditor(), 'editor.action.revealDefinition');
    const elapsed = Date.now() - started;
    expect(outcome).toEqual({ kind: 'timed-out' });
    expect(opened).toEqual([]);
    // The whole point of the separate, shorter deadline: the caret is held hostage by this
    // probe on every lone-alias navigation, so it must not cost NAV_TIMEOUT_MS (6 s).
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(4000);
  });

  it('a type-check that answers "nothing unresolved" still navigates', async () => {
    workerWith(async () => []);
    const outcome = await runNavCommand(fakeEditor(), 'editor.action.revealDefinition');
    expect(outcome).toEqual({ kind: 'navigated' });
    expect(opened).toHaveLength(1);
  });

  it('a type-check that names the unresolved module reports it, and holds the caret', async () => {
    workerWith(async () => [
      { code: 2307, start: SOURCE.indexOf("'zod'"), length: 5, messageText: 'Cannot find module' },
    ]);
    const outcome = await runNavCommand(fakeEditor(), 'editor.action.revealDefinition');
    expect(outcome).toEqual({ kind: 'resolving', specifier: 'zod', fromFile: TARGET });
    expect(opened).toEqual([]);
    // WHICH sentence is `navOutcomeMessage`'s call and is covered in nav-outcome.test.ts —
    // no project has been indexed in this test, so it is the warming-up one. What matters
    // here is that the caret stayed put and the user was told something.
    expect(getToastsSnapshot()).toHaveLength(1);
    expect(getToastsSnapshot()[0].message).not.toMatch(/no definition/i);
  });
});
