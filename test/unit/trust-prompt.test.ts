// @vitest-environment jsdom
/**
 * The Workspace Trust prompt (docs/specs/2026-09-23-workspace-trust.md §3): its copy, the bounded
 * parent button, and the keyboard route — asking for trust moves focus onto the prompt, while a
 * prompt the host raises on its own never steals focus from the editor.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LspTrustPrompt } from '../../src/lsp-protocol';
import { TrustPrompt } from '../../webview/components/trust-prompt';
import { applyTrustState } from '../../webview/lsp-status';
import { requestTrust } from '../../webview/lsp-sync';

const h = vi.hoisted(() => ({
  sent: [] as unknown[],
  /** What the host answers an lsp:trustRequest with. */
  trustReply: { ok: true, promptId: 'p1' as string | null },
}));
vi.mock('monaco-editor', () => ({ editor: { onDidCreateModel: () => ({ dispose() {} }) } }));
vi.mock('../../webview/bridge', () => ({
  lspInvoke: (m: { type: string }) => {
    h.sent.push(m);
    return Promise.resolve(m.type === 'lsp:trustRequest' ? h.trustReply : { ok: true });
  },
  subscribe: () => () => {},
}));
const sent = h.sent;

const PROMPT: LspTrustPrompt = {
  id: 'p1',
  folder: 'C:\\Users\\n\\code\\very-long-clone-name',
  parent: 'C:\\Users\\n\\code',
  languageId: 'go',
  displayName: 'Go',
  runsTools: 'gopls, go list',
};

let root: Root | null = null;
let host: HTMLElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  act(() => applyTrustState({ trusted: [], prompt: null }));
  sent.length = 0;
});

function mount() {
  host = document.createElement('div');
  document.body.append(host);
  const editor = document.createElement('textarea');
  document.body.append(editor);
  editor.focus();
  root = createRoot(host);
  act(() => root?.render(createElement(TrustPrompt)));
  return editor;
}

describe('TrustPrompt', () => {
  it('shows the question, the full folder, the tools and the parent it would trust', () => {
    mount();
    act(() => applyTrustState({ trusted: [], prompt: PROMPT }));
    const text = host.textContent ?? '';
    expect(text).toContain('Do you trust the authors of the files in this folder?');
    expect(text).toContain(PROMPT.folder);
    expect(text).toContain('(gopls, go list)');
    const parent = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Trust Parent Folder'),
    );
    expect(parent?.textContent).toBe('Trust Parent Folder: C:\\Users\\n\\code');
  });

  it('offers no parent button when the host offered no parent', () => {
    mount();
    act(() => applyTrustState({ trusted: [], prompt: { ...PROMPT, parent: null } }));
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Trust', 'Don’t Trust']);
  });

  it('answers by the host prompt id only', () => {
    mount();
    act(() => applyTrustState({ trusted: [], prompt: PROMPT }));
    act(() => host.querySelector('button')?.click());
    expect(sent).toEqual([{ type: 'lsp:trustAnswer', promptId: 'p1', choice: 'trust' }]);
  });

  it('a prompt the host raises on its own leaves focus where it was', () => {
    const editor = mount();
    act(() => applyTrustState({ trusted: [], prompt: PROMPT }));
    expect(document.activeElement).toBe(editor);
  });

  /** requestTrust is what Trust Folder…, the Restricted breadcrumb and the palette all call. */
  async function ask(promptId: string | null, ok = true) {
    h.trustReply = { ok, promptId };
    await act(async () => requestTrust('C:wamain.go', 'go'));
  }

  it('asking for trust focuses the requested prompt — before or after it arrives', async () => {
    const editor = mount();
    await ask('p1');
    act(() => applyTrustState({ trusted: [], prompt: PROMPT }));
    expect(document.activeElement?.textContent).toBe('Trust');
    editor.focus();
    await ask('p1');
    expect(document.activeElement?.textContent).toBe('Trust');
  });

  it('asking for folder A while B’s prompt shows never focuses B (Enter must not trust B)', async () => {
    const editor = mount();
    act(() => applyTrustState({ trusted: [], prompt: { ...PROMPT, id: 'B' } }));
    await ask('A');
    expect(document.activeElement).toBe(editor);
    act(() => applyTrustState({ trusted: [], prompt: { ...PROMPT, id: 'A' } }));
    expect(document.activeElement?.textContent).toBe('Trust');
  });

  it('a refused or already-trusted request leaves nothing armed for a later prompt', async () => {
    const editor = mount();
    await ask(null, false);
    await ask(null, true);
    act(() => applyTrustState({ trusted: [], prompt: PROMPT }));
    expect(document.activeElement).toBe(editor);
  });
});
