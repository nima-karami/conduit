import type {
  AppLaunch,
  HelperToSupervisor,
  ServerToSupervisor,
  ServicePhase,
  SupervisorToHelper,
  SupervisorToServer,
  TrayView,
  TrayViewInput,
} from '../../src/contracts/tray-protocol';
import type { SupervisorMarker } from '../supervise';

// See docs/plans/2026-11-03-tray-helper.plan.md C1 and P3.
export type SuperviseExit =
  | { reason: 'done' | 'doneCoreIdle' }
  | { reason: 'trayStop'; ok: true; killed: number }
  | { reason: 'trayStop'; ok: false; error: string };

export interface SuperviseOptions {
  userData: string;
  logPath: string;
  spawnChild: () => Promise<number | null>;
  core?: {
    hasOtherLiveTerminals(): Promise<boolean>;
    stop(): Promise<void>;
  };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  marker?: SupervisorMarker;
  log?: (message: string) => void;
  stopSignal?: AbortSignal;
  stopSessions?: () => Promise<number>;
  hooks?: SuperviseHooks;
  /** F9 before D17: `hc server stop` waits on this terminal, so the helper must get `exit` first. */
  ending?: (exit: SuperviseExit) => Promise<void>;
}

export interface SuperviseHooks {
  phase(p: ServicePhase): void;
  childExit(code: number | null): void;
}

export interface ServerChannel {
  send(m: SupervisorToServer): void;
  onMessage(cb: (m: ServerToSupervisor) => void): () => void;
  closed: Promise<void>;
}

export interface TrayArgs {
  source: string;
  app: AppLaunch | null;
}

export interface TrayLog {
  write(level: 'info' | 'warn' | 'error', who: 'helper' | 'supervisor', message: string): void;
}

export interface HelperHandle {
  send(m: SupervisorToHelper): void;
  exited: Promise<number | null>;
  pid: number;
}

export interface HelperLauncher {
  start(onMessage: (m: HelperToSupervisor) => void): Promise<HelperHandle | null>;
}

export interface TraySeam {
  mirror(dir: 'in' | 'out', m: object): void;
  injected(cb: (m: HelperToSupervisor) => void): () => void;
}

export interface TrayRelay {
  hooks: SuperviseHooks;
  stopSignal: AbortSignal;
  attachServer(ch: ServerChannel): void;
  finish(exit: SuperviseExit): Promise<void>;
}

export interface TrayRelayDeps {
  tray: TrayArgs;
  launcher: HelperLauncher;
  view(i: TrayViewInput): TrayView;
  pollRunning(): Promise<number | null>;
  log: TrayLog;
  seam: TraySeam | null;
  profileLabel: string | null;
  now(): number;
  setTimer(ms: number, cb: () => void): () => void;
}
