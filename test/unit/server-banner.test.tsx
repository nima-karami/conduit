// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerUiState } from '../../src/protocol';
import { ServerBanner } from '../../webview/components/server-banner';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
});

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((el) => el.textContent?.includes(label));
  if (!b) throw new Error(`no ${label} button`);
  return b;
}

async function render(state: ServerUiState) {
  const host = document.createElement('div');
  const r = createRoot(host);
  root = r;
  const onRetry = vi.fn();
  const onStopAllAndContinue = vi.fn();
  await act(async () =>
    r.render(
      <ServerBanner state={state} onRetry={onRetry} onStopAllAndContinue={onStopAllAndContinue} />,
    ),
  );
  return { host, onRetry, onStopAllAndContinue };
}

describe('ServerBanner', () => {
  it('stays hidden while connecting or reconnecting', async () => {
    for (const state of [{ state: 'connecting' }, { state: 'reconnecting' }] as const) {
      const { host } = await render(state);
      expect(host.querySelector('[role="status"]')).toBeNull();
      await act(async () => root?.unmount());
      root = null;
    }
  });

  it('shows the unavailable log path and retries', async () => {
    const { host, onRetry } = await render({
      state: 'unavailable',
      reason: 'start-failed',
      logPath: '/tmp/server.log',
    });
    expect(host.textContent).toContain('/tmp/server.log');
    const retry = button(host, 'Retry');
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('offers Stop all agents and continue when a newer Conduit runs the agents', async () => {
    const { host, onStopAllAndContinue } = await render({
      state: 'downgrade',
      serverVersion: '9.9.9',
    });
    expect(host.textContent).toContain('A newer Conduit is running its agents');
    const stop = button(host, 'Stop all agents and continue');
    await act(async () => stop.click());
    expect(onStopAllAndContinue).toHaveBeenCalledOnce();
  });

  it('shows stopped reason and retry', async () => {
    const { host, onRetry } = await render({
      state: 'stopped',
      reason: 'budget exhausted',
      logPath: '/tmp/log',
    });
    expect(host.textContent).toContain('budget exhausted');
    expect(host.textContent).toContain('/tmp/log');
    await act(async () => button(host, 'Retry').click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows runtime starting and degraded notices', async () => {
    const starting = await render({ state: 'connected', runtime: { state: 'starting' } });
    expect(starting.host.textContent).toContain('starting');
    await act(async () => root?.unmount());
    root = null;
    const degraded = await render({
      state: 'connected',
      runtime: { state: 'degraded', reason: 'core replaced', hcVersion: '1' },
    });
    expect(degraded.host.textContent).toContain('core replaced');
  });

  it('shows the runtime unavailable reason and log, with no action', async () => {
    const { host } = await render({
      state: 'connected',
      runtime: {
        state: 'unavailable',
        reason: 'token store unavailable',
        logPath: '/tmp/runtime.log',
      },
    });
    expect(host.textContent).toContain('token store unavailable');
    expect(host.textContent).toContain('/tmp/runtime.log');
    expect(host.querySelector('button')).toBeNull();
  });

  it('renders nothing when connected and the runtime is ready', async () => {
    const { host } = await render({
      state: 'connected',
      runtime: { state: 'ready', hcVersion: '0.1.16' },
    });
    expect(host.firstChild).toBeNull();
  });
});
