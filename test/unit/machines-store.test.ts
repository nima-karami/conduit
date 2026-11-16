// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineError } from '../../src/contracts/machines';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

const h = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  listeners: new Set<(m: HostToWebview) => void>(),
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => h.posted.push(m),
  subscribe: (cb: (m: HostToWebview) => void) => {
    h.listeners.add(cb);
    return () => h.listeners.delete(cb);
  },
}));

import { connectMachine, useMachineErrors } from '../../webview/machines-store';

const emit = (m: HostToWebview) => {
  for (const l of [...h.listeners]) l(m);
};

const lastRequestId = (): number => {
  const m = h.posted[h.posted.length - 1];
  if (!m || !('requestId' in m) || typeof m.requestId !== 'number') {
    throw new Error('no numbered request posted');
  }
  return m.requestId;
};

const failure = (code: MachineError['code']): MachineError => ({
  code,
  detail: { reason: 'x' },
});

let errors: ReadonlyMap<string, MachineError> = new Map();
function Probe() {
  errors = useMachineErrors();
  return null;
}

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(async () => {
  h.posted.length = 0;
  h.listeners.clear();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(createElement(Probe)));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('machines-store', () => {
  it('a connect error is kept per machine until a successful connect', async () => {
    const first = connectMachine('bee');
    await act(async () =>
      emit({
        type: 'machines:result',
        requestId: lastRequestId(),
        result: { ok: false, error: failure('ssh_needs_person') },
      }),
    );
    await first;
    expect(errors.get('bee')?.code).toBe('ssh_needs_person');

    const other = connectMachine('cee');
    await act(async () =>
      emit({
        type: 'machines:result',
        requestId: lastRequestId(),
        result: { ok: false, error: failure('ssh_unreachable') },
      }),
    );
    await other;
    expect(errors.get('cee')?.code).toBe('ssh_unreachable');
    expect(errors.get('bee')?.code).toBe('ssh_needs_person');

    const retry = connectMachine('bee');
    await act(async () =>
      emit({
        type: 'machines:result',
        requestId: lastRequestId(),
        result: { ok: true, value: null },
      }),
    );
    await retry;
    expect(errors.has('bee')).toBe(false);
    expect(errors.get('cee')?.code).toBe('ssh_unreachable');
  });
});
