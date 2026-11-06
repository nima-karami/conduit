import type { RuntimeHealth, ServerEvents } from './server-protocol';

// See docs/specs/2026-11-03-tray-helper.md §5.
export const TRAY_PROTOCOL_VERSION = 1;

export interface TrayCounts {
  running: number;
  needsYou: number;
  health: RuntimeHealth['state'];
  stopping: ServerEvents['server.stopping']['reason'] | null;
}

export type ServerToSupervisor =
  | { type: 'ready' }
  | { type: 'counts'; counts: TrayCounts }
  | { type: 'stopAllResult'; id: number; ok: true; killed: number }
  | { type: 'stopAllResult'; id: number; ok: false; reason: string };
export type SupervisorToServer = { type: 'stopAll'; id: number };

export type ServicePhase =
  | { phase: 'serving' }
  | { phase: 'spawning' }
  | { phase: 'restarting' }
  | { phase: 'exhausted'; retryAt: string }
  | { phase: 'stopping' };

export type TraySource =
  | { source: 'server'; counts: TrayCounts }
  | { source: 'hc'; running: number; needsYou: null }
  | { source: 'none' };

export interface TrayViewInput {
  phase: ServicePhase;
  source: TraySource;
  profileLabel: string | null;
}

export type SupervisorToHelper =
  | { type: 'init'; v: 1; app: AppLaunch | null }
  | { type: 'view'; view: TrayView }
  | { type: 'stopResult'; ok: true }
  | { type: 'stopResult'; ok: false; title: string; body: string }
  | { type: 'exit' };

export interface AppLaunch {
  exe: string;
  args: string[];
  cwd: string;
}

export interface TrayView {
  visible: boolean;
  icon: 'normal' | 'needsYou' | 'warning';
  tooltip: string;
  items: TrayItem[];
  confirm: { title: string; body: string; confirm: string; cancel: string };
  openFailed: { title: string; body: string };
}

export type TrayItem =
  | { kind: 'label'; text: string }
  | { kind: 'separator' }
  | { kind: 'action'; id: 'open' | 'stopAll'; text: string; enabled: boolean; isDefault?: true };

export type HelperToSupervisor =
  | { type: 'hello'; v: 1; helperVersion: string; pid: number }
  | { type: 'shown' }
  | { type: 'hidden' }
  | { type: 'stopAll' }
  | { type: 'opened' }
  | { type: 'openFailed'; reason: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export const TRAY_EXIT = { asked: 0, shellUnavailable: 10, protocol: 11 } as const;

// See docs/plans/2026-11-03-tray-helper.plan.md C1 and P4.
export const TRAY_LIMITS = {
  maxLineBytes: 65_536,
  tooltipUnits: 127,
  countsCoalesceMs: 250,
  hcPollMs: 15_000,
  spawningWaitMs: 10_000,
  stopAnswerMs: 20_000,
  exitGraceMs: 2_000,
  failedStopExitGraceMs: 60_000,
  helperRestartMs: [1_000, 5_000, 30_000],
  helperGiveUp: { crashes: 3, windowMs: 600_000 },
  nimAddRetryMs: 2_000,
  nimAddBudgetMs: 60_000,
  logCapBytes: 1_048_576,
  seamPollMs: 250,
} as const;

export const SUPERVISOR_TRAY_FLAGS = ['--tray', '--app-exe', '--app-arg', '--app-cwd'] as const;
export const HELPER_ENV_KEYS = [
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
] as const;
