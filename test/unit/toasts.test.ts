// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Toasts } from '../../webview/components/toasts';
import { __resetToastsForTest, pushToast } from '../../webview/toast-store';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  __resetToastsForTest();
});

function mount(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(createElement(Toasts)));
}

describe('Toasts', () => {
  it('renders a command as a code element after the message, with no literal backticks', () => {
    mount();
    act(() => {
      pushToast({
        message: 'Go needs gopls — install with',
        code: 'go install x',
        variant: 'info',
      });
    });
    const msg = document.querySelector('.toast__msg');
    expect(msg?.querySelector('code.toast__code')?.textContent).toBe('go install x');
    expect(msg?.textContent).toBe('Go needs gopls — install with go install x');
    expect(msg?.textContent).not.toContain('`');
  });

  it('renders no code element for a plain toast', () => {
    mount();
    act(() => {
      pushToast({ message: 'Saved elsewhere', variant: 'info' });
    });
    expect(document.querySelector('.toast__msg')?.textContent).toBe('Saved elsewhere');
    expect(document.querySelector('.toast__code')).toBeNull();
  });
});
