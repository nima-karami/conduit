// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineActionResult, MachineError } from '../../src/contracts/machines';
import type { NetworkState } from '../../src/contracts/network-state';
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

import {
  connectMachine,
  disconnectMachine,
  removeMachine,
  renameMachine,
  useMachineErrors,
} from '../../webview/machines-store';

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

const TIMED_OUT: MachineActionResult = {
  ok: false,
  error: { code: 'ssh_unreachable', detail: { reason: 'timeout' } },
};

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
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(createElement(Probe)));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
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

  it('a machine that comes up clears its kept error', async () => {
    const pending = connectMachine('bee');
    await act(async () =>
      emit({
        type: 'machines:result',
        requestId: lastRequestId(),
        result: { ok: false, error: failure('ssh_unreachable') },
      }),
    );
    await pending;
    expect(errors.has('bee')).toBe(true);

    const state: NetworkState = {
      machineId: 'm-00000001',
      selfName: 'this',
      listening: [],
      links: [],
      pairing: null,
      machines: [
        {
          machine: 'bee',
          machine_id: 'm-0000000b',
          target: 'bee.example',
          state: 'up',
          mode: 'full',
          os: 'linux',
          arch: 'x64',
          conduit_version: '1',
          agents: [],
          sessions: 0,
          last_seen: null,
          survives_logout: null,
        },
      ],
    };
    await act(async () => emit({ type: 'network:state', state }));
    expect(errors.has('bee')).toBe(false);
  });

  it('every timed-out machine action answers ssh_unreachable with reason timeout', async () => {
    vi.useFakeTimers();
    try {
      const connect = connectMachine('bee');
      await act(async () => {
        vi.advanceTimersByTime(135_000);
      });
      expect(await connect).toEqual(TIMED_OUT);
      expect(errors.get('bee')).toEqual(TIMED_OUT.error);

      const rename = renameMachine('m-0000000b', 'x');
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(await rename).toEqual(TIMED_OUT);

      const remove = removeMachine('m-0000000b');
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(await remove).toEqual(TIMED_OUT);

      const disconnect = disconnectMachine('bee');
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(await disconnect).toEqual(TIMED_OUT);
      // Only connect records its error; the other actions leave the kept error alone.
      expect(errors.get('bee')).toEqual(TIMED_OUT.error);
    } finally {
      vi.useRealTimers();
    }
  });
});
