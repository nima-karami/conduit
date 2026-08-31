// @vitest-environment jsdom

import * as MONACO from 'monaco-editor';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import { clearHeadBlobCache } from '../../webview/head-blob-cache';
import { type ChangeMarkersApi, useChangeMarkers } from '../../webview/use-change-markers';

/**
 * The regression this exists for: the hook used to re-bind on a bumped "editor epoch" that the
 * consumer set from inside its own mount effect, so ONE editor produced TWO `git:headBlob`
 * requests — two `git show` spawns per opened file — and built, cleared and rebuilt its
 * decorations collection on the way. The count below is the guard.
 */

const bus = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  listeners: new Set<(m: HostToWebview) => void>(),
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => {
    bus.posted.push(m);
  },
  subscribe: (cb: (m: HostToWebview) => void) => {
    bus.listeners.add(cb);
    return () => {
      bus.listeners.delete(cb);
    };
  },
}));

// The hook reads exactly two runtime values off monaco (the ruler lane and the minimap
// position); the real module drags in workers and CSS that jsdom cannot load.
vi.mock('monaco-editor', () => ({
  editor: {
    OverviewRulerLane: { Left: 1 },
    MinimapPosition: { Inline: 1, Gutter: 2 },
    // The hook asks the model for LF explicitly, so the fingerprint it publishes cannot drift
    // with a CRLF buffer.
    EndOfLinePreference: { TextDefined: 0, LF: 1, CRLF: 2 },
  },
}));

const PATH = '/repo/src/a.ts';
const SHA = 'a'.repeat(40);
const HEAD_TEXT = 'one\ntwo\nthree\n';

interface FakeEditor {
  collections: number;
  sets: number;
  /** The decorations of the most recent set(), so a test can see what reached monaco. */
  last: {
    options: {
      linesDecorationsClassName?: string;
      overviewRuler?: unknown;
      minimap?: unknown;
    };
  }[];
}

/** Minimum of Monaco's editor surface the hook actually touches. */
function makeEditor(text: string): { editor: unknown; probe: FakeEditor } {
  const probe: FakeEditor = { collections: 0, sets: 0, last: [] };
  const model = {
    getValue: (_eol?: number) => text,
    getLineCount: () => text.split('\n').length,
    onDidChangeContent: () => ({ dispose: () => {} }),
  };
  const editor = {
    getModel: () => model,
    createDecorationsCollection: () => {
      probe.collections++;
      return {
        set: (decos: FakeEditor['last']) => {
          probe.sets++;
          probe.last = decos;
        },
        clear: () => {},
      };
    },
    getPosition: () => ({ lineNumber: 1 }),
    setPosition: () => {},
    revealLineInCenter: () => {},
    focus: () => {},
  };
  return { editor, probe };
}

/** The live API of the last render, for the assertions that are about what the hook SAYS. */
let api: ChangeMarkersApi | null = null;

function Probe({
  editor,
  ignoreWhitespace = false,
}: {
  editor: unknown;
  ignoreWhitespace?: boolean;
}): ReactNode {
  // biome-ignore lint/suspicious/noExplicitAny: the stub above is the only editor surface the hook uses; typing it as the full IStandaloneCodeEditor would be a 200-line fiction.
  api = useChangeMarkers({
    editor: editor as any,
    path: PATH,
    enabled: true,
    themeId: 'aero-dark',
    ignoreWhitespace,
  });
  return null;
}

let root: Root | null = null;

const render = async (editor: unknown, ignoreWhitespace = false) => {
  await act(async () => {
    root?.render(createElement(Probe, { editor, ignoreWhitespace }));
  });
};

const headBlobRequests = () => bus.posted.filter((m) => m.type === 'git:headBlob');

const reply = async (blob: Partial<Extract<HostToWebview, { type: 'git:headBlobResult' }>>) => {
  const req = headBlobRequests().at(-1);
  await act(async () => {
    for (const cb of bus.listeners) {
      cb({
        type: 'git:headBlobResult',
        requestId: (req as { requestId: number }).requestId,
        path: PATH,
        headSha: SHA,
        text: HEAD_TEXT,
        ...blob,
      } as HostToWebview);
    }
  });
};

const replyWithHead = () => reply({});

/** The live region is set a frame after it is cleared, so it can be spoken twice in a row. */
const announcement = async (): Promise<string> => {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
  return api?.announcement ?? '';
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearHeadBlobCache();
  bus.posted.length = 0;
  bus.listeners.clear();
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
});

describe('useChangeMarkers request lifecycle', () => {
  it('asks the host for the HEAD blob exactly once per opened editor', async () => {
    const { editor } = makeEditor(HEAD_TEXT);
    await render(editor);
    expect(headBlobRequests()).toHaveLength(1);
  });

  it('does not refetch when the consumer re-renders with the same editor', async () => {
    const { editor } = makeEditor(HEAD_TEXT);
    await render(editor);
    await render(editor);
    await render(editor);
    expect(headBlobRequests()).toHaveLength(1);
  });

  it('creates exactly one decorations collection for one editor', async () => {
    const { editor, probe } = makeEditor(HEAD_TEXT);
    await render(editor);
    await render(editor);
    expect(probe.collections).toBe(1);
  });

  it('serves a second editor on the same path from the cache, without a second request', async () => {
    const first = makeEditor(HEAD_TEXT);
    await render(first.editor);
    await replyWithHead();
    const second = makeEditor(HEAD_TEXT);
    await render(second.editor);
    expect(headBlobRequests()).toHaveLength(1);
    expect(second.probe.collections).toBe(1);
  });

  it('marks the changed lines once the blob arrives', async () => {
    const { editor, probe } = makeEditor('one\nCHANGED\nthree\n');
    await render(editor);
    expect(probe.sets).toBe(0);
    await replyWithHead();
    expect(probe.sets).toBeGreaterThan(0);
  });
});

/** Spec 2026-08-31-review-fidelity §4 — what the map shows and what it says when it shows nothing. */
describe('useChangeMarkers map and announcements', () => {
  // The lane and the minimap POSITION that readStyle() actually picks. change-decorations.test.ts
  // injects a fake style object, so nothing else inside `npm run verify` can see these — and both
  // were chosen in this lane on measured pixels that only an e2e outside the gate witnesses.
  it('maps a tracked file onto the ruler and the minimap, at the real lane and position', async () => {
    const { editor, probe } = makeEditor('one\nCHANGED\nthree\n');
    await render(editor);
    await replyWithHead();
    expect(probe.last).toHaveLength(1);
    expect(probe.last[0].options.overviewRuler).toEqual({
      color: expect.any(String),
      position: MONACO.editor.OverviewRulerLane.Left,
    });
    // Inline, not Gutter: Gutter is a hardcoded 2 px sliver, a third of the ruler mark it echoes.
    expect(probe.last[0].options.minimap).toEqual({
      color: expect.any(String),
      position: MONACO.editor.MinimapPosition.Inline,
    });
    expect(MONACO.editor.MinimapPosition.Inline).not.toBe(MONACO.editor.MinimapPosition.Gutter);
  });

  // AC-T3.5: no baseline, no map. The gutter bars stay — every line really is new — but one
  // whole-file marker on the ruler is a solid stripe that locates nothing.
  it('keeps an untracked file OFF both maps while keeping its gutter bars', async () => {
    const { editor, probe } = makeEditor('fresh\nlines\n');
    await render(editor);
    await reply({ text: null, headSha: null, reason: 'untracked' });
    expect(api?.untracked).toBe(true);
    expect(probe.last).toHaveLength(1);
    expect(probe.last[0].options.linesDecorationsClassName).toBe('cdec cdec--added');
    expect(probe.last[0].options.overviewRuler).toBeUndefined();
    expect(probe.last[0].options.minimap).toBeUndefined();
  });

  // AC-T3.6: one setting, two surfaces. `computeFileReview`'s own whitespace handling is covered
  // in review-hunks-whitespace; what is asserted here is that the editor honours the setting at
  // all, and re-diffs the buffer it already holds when the user flips it.
  it('follows the ignore-whitespace setting, and re-diffs when it flips', async () => {
    const { editor, probe } = makeEditor('  one\n  two\n  three\n');
    await render(editor, false);
    await replyWithHead();
    expect(probe.last.length).toBeGreaterThan(0);

    const before = headBlobRequests().length;
    await render(editor, true);
    expect(probe.last).toHaveLength(0);
    expect(headBlobRequests()).toHaveLength(before);

    await render(editor, false);
    expect(probe.last.length).toBeGreaterThan(0);
  });

  // AC-T3.7: every one of these used to take the same silent clear(), indistinguishable from
  // "this file has no changes" — most often for a folder that simply is not a git repo.
  for (const [reason, expected] of [
    ['notRepo', /not a git repository/i],
    ['binary', /binary file/i],
    ['oversize', /too large to compare/i],
    ['error', /could not read/i],
  ] as const) {
    it(`announces "${reason}" instead of falling silent`, async () => {
      const { editor, probe } = makeEditor('one\ntwo\nthree\n');
      await render(editor);
      await reply({ text: null, headSha: null, reason });
      expect(probe.last).toHaveLength(0);
      act(() => api?.goToChange('next'));
      const spoken = await announcement();
      expect(spoken).toMatch(expected);
      // Not the generic "No changes", which is what every one of these used to say.
      expect(spoken).not.toBe('No changes');
    });
  }

  it('announces "No changes" when the file really is unchanged', async () => {
    const { editor } = makeEditor(HEAD_TEXT);
    await render(editor);
    await replyWithHead();
    act(() => api?.goToChange('next'));
    expect(await announcement()).toBe('No changes');
  });
});
