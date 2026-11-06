import { attentionChipLabel } from './attention';
import type { ServicePhase, TrayItem, TrayView, TrayViewInput } from './contracts/tray-protocol';
import { TRAY_LIMITS } from './contracts/tray-protocol';
import {
  agentsRunning,
  confirmBody,
  serviceExhausted,
  TRAY_PRODUCT,
  TRAY_STRINGS,
} from './tray-strings';

// Snooze is deliberately ignored (L7): see docs/specs/archive/2026-11-03-tray-helper.md §8.

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The helper truncates too (plan S1); cutting on a code point here keeps a pair from splitting.
function fitTooltip(text: string): string {
  const max = TRAY_LIMITS.tooltipUnits;
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function isStopping(i: TrayViewInput): boolean {
  return (
    i.phase.phase === 'stopping' ||
    (i.source.source === 'server' && i.source.counts.stopping !== null)
  );
}

function serviceLabel(i: TrayViewInput, phase: ServicePhase): string | null {
  switch (phase.phase) {
    case 'spawning':
      return TRAY_STRINGS.serviceStarting;
    case 'restarting':
      return TRAY_STRINGS.serviceRestarting;
    case 'exhausted':
      return serviceExhausted(hhmm(phase.retryAt));
    case 'stopping':
      return null;
    case 'serving': {
      if (i.source.source !== 'server') return null;
      switch (i.source.counts.health) {
        case 'degraded':
          return TRAY_STRINGS.serviceDegraded;
        case 'starting':
          return TRAY_STRINGS.serviceStarting;
        case 'unavailable':
          return TRAY_STRINGS.serviceUnavailable;
        default:
          return null;
      }
    }
  }
}

function runningOf(source: TrayViewInput['source']): number {
  if (source.source === 'none') return 0;
  return source.source === 'hc' ? source.running : source.counts.running;
}

export function trayView(i: TrayViewInput): TrayView {
  const running = runningOf(i.source);
  const needsYou = i.source.source === 'server' ? i.source.counts.needsYou : 0;
  const stopping = isStopping(i);
  const service = stopping ? null : serviceLabel(i, i.phase);

  const needsYouClause = attentionChipLabel(needsYou);
  const runningText = agentsRunning(running);

  const parts: string[] = stopping
    ? [TRAY_STRINGS.stopping]
    : [needsYouClause ? `${runningText}, ${needsYouClause}` : runningText];
  if (service) parts.push(service);
  const tooltip = fitTooltip(`${i.profileLabel ?? TRAY_PRODUCT} — ${parts.join('. ')}`);

  const items: TrayItem[] = [];
  if (i.profileLabel !== null) items.push({ kind: 'label', text: i.profileLabel });
  items.push({ kind: 'label', text: runningText });
  if (needsYouClause && !stopping) items.push({ kind: 'label', text: needsYouClause });
  const phaseLabel = stopping ? TRAY_STRINGS.stopping : service;
  if (phaseLabel) items.push({ kind: 'label', text: phaseLabel });
  items.push(
    { kind: 'separator' },
    { kind: 'action', id: 'open', text: TRAY_STRINGS.open, enabled: true, isDefault: true },
    { kind: 'action', id: 'stopAll', text: TRAY_STRINGS.stopAll, enabled: !stopping },
  );

  const icon = stopping ? 'normal' : service ? 'warning' : needsYou > 0 ? 'needsYou' : 'normal';

  return {
    visible: running >= 1,
    icon,
    tooltip,
    items,
    confirm: {
      title: TRAY_STRINGS.confirmTitle,
      body: confirmBody(running, needsYouClause),
      confirm: TRAY_STRINGS.confirmButton,
      cancel: TRAY_STRINGS.cancelButton,
    },
    openFailed: { title: TRAY_STRINGS.openFailedTitle, body: TRAY_STRINGS.openFailedBody },
  };
}

// null for the packaged default (<appData>/Conduit), so only a second profile is labelled (spec §7 F12).
export function profileLabelOf(userData: string, appData: string, sep: '/' | '\\'): string | null {
  const trim = (p: string) => p.replace(/[\\/]+$/, '');
  const ud = trim(userData);
  const def = `${trim(appData)}${sep}Conduit`;
  if (ud.toLowerCase() === def.toLowerCase()) return null;
  const leaf = ud.split(/[\\/]/).pop() ?? '';
  return leaf ? `Conduit (${leaf})` : null;
}
