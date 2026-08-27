// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import { clearHeadBlobCache } from '../../webview/head-blob-cache';
import { useChangeMarkers } from '../../webview/use-change-markers';

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
  editor: { OverviewRulerLane: { Left: 1 }, MinimapPosition: { Gutter: 2 } },
}));

const PATH = '/repo/src/a.ts';
const SHA = 'a'.repeat(40);
const HEAD_TEXT = 'one\ntwo\nthree\n';

interface FakeEditor {
  collections: number;
  sets: number;
}

/** Minimum of Monaco's editor surface the hook actually touches. */
function makeEditor(text: string): { editor: unknown; probe: FakeEditor } {
  const probe: FakeEditor = { collections: 0, sets: 0 };
  const model = {
    getValue: () => text,
    getLineCount: () => text.split('\n').length,
    onDidChangeContent: () => ({ dispose: () => {} }),
  };
  const editor = {
    getModel: () => model,
    createDecorationsCollection: () => {
      probe.collections++;
      return {
        set: () => {
          probe.sets++;
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

function Probe({ editor }: { editor: unknown }): ReactNode {
  // biome-ignore lint/suspicious/noExplicitAny: the stub above is the only editor surface the hook uses; typing it as the full IStandaloneCodeEditor would be a 200-line fiction.
  useChangeMarkers({ editor: editor as any, path: PATH, enabled: true, themeId: 'aero-dark' });
  return null;
}

let root: Root | null = null;

const render = async (editor: unknown) => {
  await act(async () => {
    root?.render(createElement(Probe, { editor }));
  });
};

const headBlobRequests = () => bus.posted.filter((m) => m.type === 'git:headBlob');

const replyWithHead = async () => {
  const req = headBlobRequests().at(-1);
  await act(async () => {
    for (const cb of bus.listeners) {
      cb({
        type: 'git:headBlobResult',
        requestId: (req as { requestId: number }).requestId,
        path: PATH,
        headSha: SHA,
        text: HEAD_TEXT,
      });
    }
  });
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
