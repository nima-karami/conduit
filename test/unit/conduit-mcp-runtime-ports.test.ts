import { describe, expect, it } from 'vitest';
import { createMcpRuntimePorts } from '../../electron/conduit-mcp-runtime-ports';
import type { SessionScreens } from '../../electron/session-screens';
import type { LaunchIds, RuntimeEvent } from '../../src/contracts/terminal-runtime';

const ids: LaunchIds = { generation: 12, launchId: 'a'.repeat(32) };
const size = { cols: 91, rows: 37 };

function harness() {
  const calls: unknown[][] = [];
  const activeModels = new Set<string>();
  let alive = true;
  const pty = {
    isAlive: () => alive,
    generation: () => 99,
    size: () => size,
  };
  const screens: SessionScreens = {
    start: (sessionId, cols, rows) => {
      calls.push(['start', sessionId, cols, rows]);
      activeModels.add(sessionId);
    },
    keepTail: (...args) => calls.push(['keepTail', ...args]),
    feed: (...args) => calls.push(['feed', ...args]),
    resize: (...args) => calls.push(['resize', ...args]),
    dispose: (sessionId) => {
      calls.push(['dispose', sessionId]);
      activeModels.delete(sessionId);
    },
    snapshot: async () => ({
      lines: ['hello'],
      cursorY: 0,
      cursorX: 5,
      cursorRowStyles: 'plain'.repeat(0),
    }),
    has: (sessionId) => activeModels.has(sessionId),
  };
  const ports = createMcpRuntimePorts({ pty, screens });
  const events: RuntimeEvent[] = [];
  ports.runtime.on((event) => events.push(event));
  return { ports, calls, events, setAlive: (next: boolean) => (alive = next) };
}

describe('createMcpRuntimePorts', () => {
  it('forwards the prepared launch identity only while the matching PTY is live', () => {
    const { ports, events, setAlive } = harness();
    ports.prepared('s1', ids);
    ports.spawned('s1');
    expect(ports.runtime.get('s1')).toEqual({
      sessionId: 's1',
      generation: ids.generation,
      launchId: ids.launchId,
      state: 'live',
      size,
      target: { hcSession: 'node-pty', terminal: 's1' },
    });
    expect(events).toEqual([
      { type: 'spawned', sessionId: 's1', generation: ids.generation, size },
    ]);
    setAlive(false);
    expect(ports.runtime.get('s1')).toBeUndefined();
    ports.spawned('s1');
    expect(events).toHaveLength(1);
  });

  it('keeps screen lifecycle idempotent and does not release on exit before listeners run', () => {
    const { ports, calls, events } = harness();
    ports.prepared('s1', ids);
    ports.screens.keepTail('s1');
    ports.screens.ensure('s1', { seedTail: true });
    ports.screens.ensure('s1', { seedTail: true });
    ports.screens.ensure('s1', { seedTail: false });
    ports.screens.keepTail('s2');
    ports.screens.ensure('s2', { seedTail: false });
    expect(calls).toEqual([
      ['keepTail', 's1', size.cols, size.rows],
      ['start', 's1', size.cols, size.rows],
      ['keepTail', 's2', size.cols, size.rows],
      ['dispose', 's2'],
      ['start', 's2', size.cols, size.rows],
    ]);

    const callsBeforeExit = calls.length;
    ports.exit('s1', 7);
    expect(events.at(-1)).toEqual({
      type: 'exit',
      sessionId: 's1',
      generation: ids.generation,
      code: 7,
      reason: 'exited',
    });
    expect(calls.slice(callsBeforeExit).some(([method]) => method === 'dispose')).toBe(false);
    expect(ports.runtime.get('s1')).toBeUndefined();
  });

  it('feeds output and size changes before notifying subscribed runtime listeners', async () => {
    const { ports, calls, events } = harness();
    ports.prepared('s1', ids);
    const observed: RuntimeEvent[] = [];
    const unsubscribe = ports.runtime.on((event) => observed.push(event));
    ports.output('s1', 'chunk');
    unsubscribe();
    ports.output('s1', 'after-unsubscribe');
    ports.resize('s1', 100, 40);
    expect(calls).toEqual([
      ['feed', 's1', 'chunk'],
      ['feed', 's1', 'after-unsubscribe'],
      ['resize', 's1', 100, 40],
    ]);
    expect(events).toEqual([
      { type: 'data', sessionId: 's1', generation: ids.generation, data: 'chunk' },
      { type: 'data', sessionId: 's1', generation: ids.generation, data: 'after-unsubscribe' },
      { type: 'size', sessionId: 's1', size: { cols: 100, rows: 40 } },
    ]);
    expect(observed).toEqual([
      { type: 'data', sessionId: 's1', generation: ids.generation, data: 'chunk' },
    ]);
    await expect(ports.runtime.screen('s1')).resolves.toEqual({
      lines: ['hello'],
      cursorY: 0,
      cursorX: 5,
      cursorRowStyles: '',
    });
  });
});
