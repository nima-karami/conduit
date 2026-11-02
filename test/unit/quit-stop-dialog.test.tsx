// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../webview/components/confirm-dialog';
import { quitStopFailureDialog } from '../../webview/quit-stop-dialog';

describe('quit stop failure dialog', () => {
  it.each([
    ['Retry', 'retry'],
    ['Quit and leave them running', 'leave'],
    ['Cancel', 'cancel'],
  ] as const)('routes %s to its explicit decision', async (label, choice) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const answer = vi.fn();
    try {
      await act(async () =>
        root.render(
          <ConfirmDialog state={quitStopFailureDialog('timeout', answer)} onClose={() => {}} />,
        ),
      );
      expect(document.body.textContent).toContain("Couldn't stop the agents: timeout");
      const button = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === label,
      );
      expect(button).toBeDefined();
      await act(async () => button?.click());
      expect(answer).toHaveBeenCalledExactlyOnceWith(choice);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
