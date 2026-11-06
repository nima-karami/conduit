import { SERVER_EXIT } from '../../src/contracts/session-identity';
import {
  type HelperToSupervisor,
  type ServerToSupervisor,
  type ServicePhase,
  type SupervisorToHelper,
  TRAY_LIMITS,
  TRAY_PROTOCOL_VERSION,
  type TraySource,
} from '../../src/contracts/tray-protocol';
import type {
  HelperHandle,
  ServerChannel,
  SuperviseExit,
  TrayRelay,
  TrayRelayDeps,
} from './contracts';

// Spec §7 F3 step 4/5 copy. Belongs in src/tray-strings.ts (G2); moved there at S8.
export const TRAY_STOP_COPY = {
  title: 'Stop all agents',
  body: (reason: string) => `Couldn't stop the agents: ${reason}`,
  starting: 'The background service is starting. Try again in a moment.',
  noAnswer: "The background service didn't answer in time.",
  closed: 'The background service stopped before it answered.',
} as const;

interface ServerEntry {
  ch: ServerChannel;
  ready: boolean;
}

/**
 * Runs beside `supervise()`, never inside it (spec §7 F7): every hook and callback is guarded so a
 * relay bug is logged to tray.log and never thrown into the restart loop; `stopSignal` is its only
 * way in (§7a). The Rust side owns the confirm and the stop latch, so each `stopAll` it sends is
 * routed once, as is.
 */
export function createTrayRelay(deps: TrayRelayDeps): TrayRelay {
  const controller = new AbortController();
  const log = (level: 'info' | 'warn' | 'error', message: string) => {
    try {
      deps.log.write(level, 'supervisor', message);
    } catch (error) {
      process.stderr.write(`tray log failed: ${String(error)}\n${message}\n`);
    }
  };
  const guard = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      log('error', `tray relay ${what}: ${String(error)}`);
    }
  };

  let phase: ServicePhase = { phase: 'spawning' };
  let source: TraySource = { source: 'none' };
  let serverState: 'none' | 'starting' | 'ready' = 'none';
  let server: ServerEntry | null = null;
  let helper: HelperHandle | null = null;
  let starting: Promise<void> | null = null;
  let lastView: string | null = null;
  let cancelPoll: (() => void) | null = null;
  let pollInFlight = false;
  let finished = false;
  let trayStopPending = false;
  let nextId = 0;
  const ipcStops = new Map<number, { entry: ServerEntry; cancel: () => void }>();
  const spawnWaits = new Set<() => void>();

  const send = (m: SupervisorToHelper) => {
    const h = helper;
    if (!h) return;
    if (deps.seam) {
      const seam = deps.seam;
      guard('seam mirror', () => seam.mirror('out', m));
    }
    guard(`send ${m.type}`, () => h.send(m));
  };

  const render = () =>
    guard('view', () => {
      if (!helper) return;
      const view = deps.view({ phase, source, profileLabel: deps.profileLabel });
      const json = JSON.stringify(view);
      if (json === lastView) return;
      lastView = json;
      send({ type: 'view', view });
    });

  const stopPolling = () => {
    cancelPoll?.();
    cancelPoll = null;
  };

  /** F2: hc is only the reading while no server is ready; the server's counts win otherwise. */
  const ensurePolling = () => {
    if (finished || !helper || serverState === 'ready') return stopPolling();
    if (cancelPoll || pollInFlight) return;
    poll();
  };

  const poll = () => {
    pollInFlight = true;
    const next = () => {
      pollInFlight = false;
      if (finished || serverState === 'ready') return;
      cancelPoll = deps.setTimer(TRAY_LIMITS.hcPollMs, () => {
        cancelPoll = null;
        poll();
      });
    };
    let reading: Promise<number | null>;
    try {
      reading = deps.pollRunning();
    } catch (error) {
      log('warn', `tray hc poll threw: ${String(error)}`);
      return next();
    }
    reading.then(
      (running) => {
        guard('poll', () => {
          if (finished || serverState === 'ready' || running === null) return;
          source = { source: 'hc', running, needsYou: null };
          render();
        });
        next();
      },
      (error: unknown) => {
        log('warn', `tray hc poll failed: ${String(error)}`);
        next();
      },
    );
  };

  const startHelper = () => {
    if (starting) return;
    starting = (async () => {
      try {
        const h = await deps.launcher.start((m) => guard(`helper ${m.type}`, () => onHelper(m)));
        if (!h) {
          log('info', 'tray helper not started (no binary)');
          return;
        }
        helper = h;
        send({ type: 'init', v: TRAY_PROTOCOL_VERSION, app: deps.tray.app });
        render();
        ensurePolling();
      } catch (error) {
        log('error', `tray helper start failed: ${String(error)}`);
      }
    })();
  };

  const fail = (reason: string) => {
    log('warn', `tray stop failed: ${reason}`);
    send({
      type: 'stopResult',
      ok: false,
      title: TRAY_STOP_COPY.title,
      body: TRAY_STOP_COPY.body(reason),
    });
  };

  const ipcStop = (entry: ServerEntry) => {
    nextId += 1;
    const id = nextId;
    log('info', `tray stopAll id=${id} via server`);
    try {
      entry.ch.send({ type: 'stopAll', id });
    } catch (error) {
      fail(String(error));
      return;
    }
    const cancel = deps.setTimer(TRAY_LIMITS.stopAnswerMs, () => {
      if (!ipcStops.delete(id)) return;
      fail(TRAY_STOP_COPY.noAnswer);
    });
    ipcStops.set(id, { entry, cancel });
  };

  /** §7a: no ready server to ask, so `supervise()` stops through hc at its current wait point. */
  const abortStop = () => {
    trayStopPending = true;
    phase = { phase: 'stopping' };
    log('info', 'tray stopAll with no ready server: aborting supervise');
    controller.abort();
    render();
  };

  const routeStop = () => {
    log('info', 'tray stopAll requested');
    if (finished) return;
    if (trayStopPending) return log('info', 'tray stopAll: a stop is already under way');
    if (serverState === 'ready' && server) return ipcStop(server);
    if (serverState === 'starting') {
      // F3 step 4: never kill behind a server that may be about to serve (W2).
      let cancel: () => void = () => {};
      const wait = () => cancel();
      cancel = deps.setTimer(TRAY_LIMITS.spawningWaitMs, () => {
        if (spawnWaits.delete(wait)) fail(TRAY_STOP_COPY.starting);
      });
      spawnWaits.add(wait);
      return;
    }
    abortStop();
  };

  const takeWaits = () => {
    const waits = [...spawnWaits];
    spawnWaits.clear();
    for (const cancel of waits) cancel();
    return waits.length;
  };

  const onServer = (entry: ServerEntry, m: ServerToSupervisor) => {
    if (m.type === 'stopAllResult') {
      const pending = ipcStops.get(m.id);
      if (!pending) return log('warn', `tray stopAllResult id=${m.id} with no pending stop`);
      ipcStops.delete(m.id);
      pending.cancel();
      if (!m.ok) return fail(m.reason);
      log('info', `tray stopAll id=${m.id} killed=${m.killed}`);
      return send({ type: 'stopResult', ok: true });
    }
    if (entry !== server) return;
    if (m.type === 'ready') {
      entry.ready = true;
      serverState = 'ready';
      if (!trayStopPending) phase = { phase: 'serving' };
      stopPolling();
      startHelper();
      render();
      for (let n = takeWaits(); n > 0; n--) ipcStop(entry);
      return;
    }
    if (m.type === 'counts' && entry.ready) {
      source = { source: 'server', counts: m.counts };
      render();
    }
  };

  const onHelper = (m: HelperToSupervisor) => {
    if (deps.seam) {
      const seam = deps.seam;
      guard('seam mirror', () => seam.mirror('in', m));
    }
    switch (m.type) {
      case 'hello':
        return log('info', `tray helper hello v=${m.v} version=${m.helperVersion} pid=${m.pid}`);
      case 'shown':
      case 'hidden':
      case 'opened':
        return log('info', `tray helper ${m.type}`);
      case 'openFailed':
        return log('warn', `tray helper openFailed: ${m.reason}`);
      case 'log':
        return deps.log.write(m.level, 'helper', m.message);
      case 'stopAll':
        return routeStop();
    }
  };

  const seamOff = deps.seam
    ? deps.seam.injected((m) => guard(`injected ${m.type}`, () => onHelper(m)))
    : null;

  const hooks = {
    phase(p: ServicePhase) {
      guard('phase', () => {
        if (p.phase === 'spawning') serverState = 'starting';
        else if (p.phase !== 'serving') serverState = 'none';
        phase = trayStopPending ? { phase: 'stopping' } : p;
        render();
        ensurePolling();
      });
    },
    childExit(code: number | null) {
      guard('childExit', () => {
        serverState = 'none';
        server = null;
        if (source.source === 'server')
          source = { source: 'hc', running: source.counts.running, needsYou: null };
        // D3: a crash (anything but done/doneCoreIdle) starts the helper even before any ready (AC13).
        if (code !== SERVER_EXIT.done && code !== SERVER_EXIT.doneCoreIdle) startHelper();
        if (takeWaits() > 0) abortStop();
        render();
        ensurePolling();
      });
    },
  };

  return {
    hooks,
    stopSignal: controller.signal,
    attachServer(ch) {
      guard('attachServer', () => {
        const entry: ServerEntry = { ch, ready: false };
        server = entry;
        ch.onMessage((m) => guard(`server ${m.type}`, () => onServer(entry, m)));
        ch.closed.then(
          () =>
            guard('server closed', () => {
              for (const [id, pending] of ipcStops) {
                if (pending.entry !== entry) continue;
                ipcStops.delete(id);
                pending.cancel();
                fail(TRAY_STOP_COPY.closed);
              }
            }),
          (error: unknown) => log('warn', `tray server channel: ${String(error)}`),
        );
      });
    },
    async finish(exit: SuperviseExit) {
      try {
        if (finished) return;
        finished = true;
        stopPolling();
        seamOff?.();
        takeWaits();
        for (const pending of ipcStops.values()) pending.cancel();
        ipcStops.clear();
        await starting;
        if (!helper) return;
        let failed = false;
        if (exit.reason === 'trayStop') {
          if (exit.ok) {
            log('info', `tray stop done killed=${exit.killed}`);
            send({ type: 'stopResult', ok: true });
          } else {
            failed = true;
            fail(exit.error);
          }
        } else if (trayStopPending) send({ type: 'stopResult', ok: true });
        send({ type: 'exit' });
        // P4: a failed stop leaves an error dialog up; don't end the helper under the user.
        const grace = failed ? TRAY_LIMITS.failedStopExitGraceMs : TRAY_LIMITS.exitGraceMs;
        let cancel: () => void = () => {};
        const timeout = new Promise<void>((resolve) => {
          cancel = deps.setTimer(grace, resolve);
        });
        await Promise.race([helper.exited.then(() => undefined), timeout]);
        cancel();
      } catch (error) {
        log('error', `tray relay finish: ${String(error)}`);
      }
    },
  };
}
