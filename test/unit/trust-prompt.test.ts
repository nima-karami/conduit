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
import { applyTrustState, requestTrustFocus } from '../../webview/lsp-status';

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock('../../webview/bridge', () => ({
  lspInvoke: (m: unknown) => {
    sent.push(m);
    return Promise.resolve({ ok: true });
  },
}));

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

  it('asking for trust (Trust Folder…, breadcrumb, palette) focuses the Trust button — before or after the prompt arrives', () => {
    mount();
    act(() => requestTrustFocus());
    act(() => applyTrustState({ trusted: [], prompt: PROMPT }));
    expect(document.activeElement?.textContent).toBe('Trust');
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    act(() => requestTrustFocus());
    expect(document.activeElement?.textContent).toBe('Trust');
    other.remove();
  });
});
