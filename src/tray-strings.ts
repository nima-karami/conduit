// All tray copy lives here (spec docs/specs/2026-11-03-tray-helper.md §8, "i18n").
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}

export const TRAY_PRODUCT = 'Conduit';

export function agentsRunning(n: number): string {
  return `${n} ${plural(n, 'agent', 'agents')} running`;
}

export const TRAY_STRINGS = {
  open: 'Open Conduit',
  stopAll: 'Stop all agents…',
  stopping: 'Stopping agents…',
  serviceDegraded: 'Background service degraded',
  serviceStarting: 'Background service starting…',
  serviceUnavailable: 'Background service unavailable',
  serviceRestarting: 'Background service restarting. Agents keep running.',
  confirmTitle: 'Stop all agents?',
  confirmButton: 'Stop all agents',
  cancelButton: 'Cancel',
  openFailedTitle: "Couldn't open Conduit",
  openFailedBody: 'Conduit could not be started. It may not be installed any more.',
} as const;

export function serviceExhausted(retryAtHhmm: string): string {
  return `Background service stopped after repeated crashes. Retrying at ${retryAtHhmm}.`;
}

export function confirmBody(running: number, needsYouClause: string | null): string {
  const verb = plural(running, 'is', 'are');
  const clause = needsYouClause ? ` (${needsYouClause})` : '';
  return `${running} ${plural(running, 'agent', 'agents')} ${verb} running in Conduit's background service${clause}. Stopping ends them. Anything they haven't saved is lost.`;
}
