import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { jumpListTasks, runStopAllAgents, STOP_ALL_AGENTS_FLAG } from '../../electron/jump-list';

const mainSource = readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');

function startupBoundary(
  input: { packaged?: boolean; platform?: string; argv?: string[]; lock?: boolean } = {},
) {
  const prefix = mainSource.split('app.whenReady().then(() => {')[1]?.split('  // Cold launch')[0];
  if (!prefix) throw new Error('missing production startup boundary');
  const calls: string[] = [];
  const tasks: Electron.Task[][] = [];
  runInNewContext(
    transformSync(`function start() {${prefix}\nnormalStart();} start();`, { loader: 'ts' }).code,
    {
      app: {
        isPackaged: input.packaged ?? true,
        requestSingleInstanceLock: () => input.lock ?? true,
        quit: () => calls.push('quit'),
        setUserTasks: (value: Electron.Task[]) => tasks.push(value),
      },
      process: {
        platform: input.platform ?? 'win32',
        argv: input.argv ?? ['/Conduit.exe'],
        execPath: '/Conduit.exe',
      },
      STOP_ALL_AGENTS_FLAG,
      jumpListTasks,
      stopAllAgentsHeadless: async () => {
        calls.push('headless');
      },
      normalStart: () => calls.push('normal-start'),
      log: { error() {} },
    },
  );
  return { calls, tasks };
}

describe('Electron Jump List startup boundary', () => {
  it('returns into the headless flow immediately after taking the lock', () => {
    const h = startupBoundary({ argv: ['/Conduit.exe', '--stop-all-agents'] });
    expect(h.calls).toEqual(['headless']);
  });

  it('losing the lock quits without starting the headless flow', () => {
    const h = startupBoundary({ argv: ['/Conduit.exe', '--stop-all-agents'], lock: false });
    expect(h.calls).toEqual(['quit']);
  });

  it('registers the installed Windows task only', () => {
    expect(startupBoundary().tasks).toEqual([jumpListTasks('/Conduit.exe')]);
    expect(startupBoundary({ packaged: false }).tasks).toEqual([]);
    expect(startupBoundary({ platform: 'darwin' }).tasks).toEqual([]);
  });
});

function mainFunction(name: string): string {
  const source = mainSource.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^\\}`, 'm'))?.[0];
  if (!source) throw new Error(`missing production ${name}`);
  return transformSync(source, { loader: 'ts', target: 'es2022' }).code;
}

describe('Electron Jump List native boundaries', () => {
  it.each([
    [{ CONDUIT_E2E_STOP_CONFIRM: 'accept' }, 1],
    [{ CONDUIT_E2E: '1' }, 1],
    [{ CONDUIT_E2E: '1', CONDUIT_E2E_STOP_CONFIRM: 'accept' }, 0],
  ] as const)('requires both seam environment values (%j)', async (env, expectedDialogs) => {
    const showMessageBox = vi.fn(async (..._args: unknown[]) => ({ response: 0 }));
    const result = await runInNewContext(
      `${mainFunction('confirmStopAllAgents')} confirmStopAllAgents();`,
      {
        process: { env },
        dialog: { showMessageBox },
      },
    );
    expect(result).toBe(expectedDialogs === 0);
    expect(showMessageBox).toHaveBeenCalledTimes(expectedDialogs);
    if (expectedDialogs)
      expect(showMessageBox.mock.calls[0]).toEqual([
        expect.objectContaining({
          buttons: ['Cancel', 'Stop all agents'],
          defaultId: 0,
          cancelId: 0,
        }),
      ]);
  });

  it('owns warm confirmation with the focused window and stops only after accepting', async () => {
    const handlerSource = mainSource.match(
      /^ {2}app.on\('second-instance', \(_event, argv\) => \{[\s\S]*?^ {2}\}\);/m,
    )?.[0];
    if (!handlerSource) throw new Error('missing production second-instance callback');
    const app = new EventEmitter();
    const owner = { isMinimized: () => false, show: vi.fn(), focus: vi.fn() };
    const confirmStopAllAgents = vi.fn(async () => false);
    const stopAllAndContinue = vi.fn(async () => {});
    const openArg = vi.fn();
    runInNewContext(
      transformSync(`let jumpListStopPending = false;\n${handlerSource}`, { loader: 'ts' }).code,
      {
        app,
        focusedWindow: () => owner,
        confirmStopAllAgents,
        lifecycle: { stopAllAndContinue },
        STOP_ALL_AGENTS_FLAG,
        log: { info() {}, error() {} },
        openArg,
        primaryWindowId: 1,
        dialog: { showErrorBox: vi.fn() },
      },
    );
    app.emit('second-instance', {}, ['/Conduit.exe', '--stop-all-agents']);
    await vi.waitFor(() => expect(confirmStopAllAgents).toHaveBeenCalledWith(owner));
    expect(stopAllAndContinue).not.toHaveBeenCalled();
    expect(openArg).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    confirmStopAllAgents.mockResolvedValue(true);
    app.emit('second-instance', {}, ['/Conduit.exe', '--stop-all-agents']);
    await vi.waitFor(() => expect(stopAllAndContinue).toHaveBeenCalledTimes(1));
    expect(owner.focus).toHaveBeenCalled();
  });

  it('stops headlessly through C2 and relaunches a normal instance received while it waits', async () => {
    const app = Object.assign(new EventEmitter(), {
      isPackaged: true,
      getAppPath: () => '/installed/app',
      relaunch: vi.fn(),
      quit: vi.fn(),
    });
    const stop = vi.fn(async (_options: unknown) => {
      app.emit('second-instance', {}, ['/Conduit.exe', '/workspace']);
      return { ok: true, killed: 2, fallback: false };
    });
    const showErrorBox = vi.fn();
    await runInNewContext(`${mainFunction('stopAllAgentsHeadless')} stopAllAgentsHeadless();`, {
      app,
      process: { argv: ['/Conduit.exe', '--stop-all-agents'], platform: 'win32', env: {} },
      STOP_ALL_AGENTS_FLAG,
      runStopAllAgents,
      confirmStopAllAgents: async () => true,
      instanceNames: () => ({ serverEndpoint: '/pipe' }),
      userData: () => '/profile',
      os: { tmpdir: () => '/temp' },
      coreStartEnv: () => ({}),
      runtimeLayout: () => ({ hcExe: '/hc.exe' }),
      aboutInfo: { version: '1.2.3' },
      stopAll: stop,
      dialog: { showErrorBox },
      log: { error() {}, warn() {} },
    });
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: '/pipe', version: '1.2.3' }),
    );
    expect(stop.mock.calls[0][0]).not.toHaveProperty('auth');
    expect(app.relaunch).toHaveBeenCalledWith({ args: ['/workspace'] });
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.listenerCount('second-instance')).toBe(0);
    expect(showErrorBox).not.toHaveBeenCalled();
  });
});

describe('Jump List stop task', () => {
  it('launches the installed app with the headless flag and its icon', () => {
    expect(STOP_ALL_AGENTS_FLAG).toBe('--stop-all-agents');
    expect(jumpListTasks('/installed/Conduit.exe')).toEqual([
      {
        program: '/installed/Conduit.exe',
        arguments: '--stop-all-agents',
        title: 'Stop all agents…',
        description: 'Stop every agent Conduit is running in the background',
        iconPath: '/installed/Conduit.exe',
        iconIndex: 0,
      },
    ]);
  });

  it('quits on cancel without stopping agents', async () => {
    const trace: string[] = [];
    expect(
      await runStopAllAgents({
        confirm: async () => {
          trace.push('confirm');
          return false;
        },
        stopAll: async () => {
          trace.push('stop');
          return { ok: true };
        },
        error: async () => {
          trace.push('error');
        },
        secondInstanceArrived: () => false,
      }),
    ).toBe('quit');
    expect(trace).toEqual(['confirm']);
  });

  it('shows a failed stop before quitting', async () => {
    const trace: string[] = [];
    expect(
      await runStopAllAgents({
        confirm: async () => true,
        stopAll: async () => {
          trace.push('stop');
          return { ok: false, reason: 'permission denied' };
        },
        error: async (message) => {
          trace.push(message);
        },
        secondInstanceArrived: () => false,
      }),
    ).toBe('quit');
    expect(trace).toEqual(['stop', 'permission denied']);
  });

  it.each([false, true])(
    'relaunches for a second instance received while confirmation is open (accept=%s)',
    async (accepted) => {
      let secondInstance = false;
      expect(
        await runStopAllAgents({
          confirm: async () => {
            secondInstance = true;
            return accepted;
          },
          stopAll: async () => ({ ok: true }),
          error: async () => {},
          secondInstanceArrived: () => secondInstance,
        }),
      ).toBe('relaunch');
    },
  );

  it('rechecks a second instance arriving while the failure dialog is open', async () => {
    let secondInstance = false;
    expect(
      await runStopAllAgents({
        confirm: async () => true,
        stopAll: async () => ({ ok: false }),
        error: async () => {
          secondInstance = true;
        },
        secondInstanceArrived: () => secondInstance,
      }),
    ).toBe('relaunch');
  });
});
