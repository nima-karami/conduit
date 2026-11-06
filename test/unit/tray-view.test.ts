import { describe, expect, it } from 'vitest';
import type { ServicePhase, TrayCounts, TraySource } from '../../src/contracts/tray-protocol';
import { profileLabelOf, trayView } from '../../src/tray-view';

const counts = (o: Partial<TrayCounts> = {}): TrayCounts => ({
  running: 3,
  needsYou: 0,
  health: 'ready',
  stopping: null,
  ...o,
});
const server = (o: Partial<TrayCounts> = {}): TraySource => ({
  source: 'server',
  counts: counts(o),
});
const hc = (running: number): TraySource => ({ source: 'hc', running, needsYou: null });
const serving: ServicePhase = { phase: 'serving' };
const view = (phase: ServicePhase, source: TraySource, profileLabel: string | null = null) =>
  trayView({ phase, source, profileLabel });
const labels = (v: ReturnType<typeof trayView>) =>
  v.items.flatMap((i) => (i.kind === 'label' ? [i.text] : []));
const stopAll = (v: ReturnType<typeof trayView>) =>
  v.items.find((i) => i.kind === 'action' && i.id === 'stopAll');

describe('trayView', () => {
  it('serving with 0 running is hidden', () => {
    expect(view(serving, server({ running: 0 })).visible).toBe(false);
  });

  it('running only', () => {
    expect(view(serving, server())).toMatchObject({
      visible: true,
      icon: 'normal',
      tooltip: 'Conduit — 3 agents running',
    });
  });

  it('needs-you badge', () => {
    const v = view(serving, server({ needsYou: 1 }));
    expect(v.icon).toBe('needsYou');
    expect(v.tooltip).toBe('Conduit — 3 agents running, 1 needs you');
    expect(labels(v)).toEqual(['3 agents running', '1 needs you']);
    expect(view(serving, server({ needsYou: 2 })).tooltip).toContain('2 need you');
  });

  it.each([
    ['degraded', 'Background service degraded'],
    ['starting', 'Background service starting…'],
    ['unavailable', 'Background service unavailable'],
  ] as const)('health %s with running >= 1 warns', (health, text) => {
    const v = view(serving, server({ health, needsYou: 1 }));
    expect(v).toMatchObject({ visible: true, icon: 'warning' });
    expect(v.tooltip).toContain(text);
    expect(labels(v)).toContain(text);
  });

  it('health not ready with running 0 is hidden', () => {
    expect(view(serving, server({ health: 'degraded', running: 0 })).visible).toBe(false);
  });

  it.each([
    [{ phase: 'spawning' } as ServicePhase, 'Background service starting…'],
    [
      { phase: 'restarting' } as ServicePhase,
      'Background service restarting. Agents keep running.',
    ],
  ])('%j with hc >= 1 shows warning and no needs-you line', (phase, text) => {
    const v = view(phase, hc(3));
    expect(v).toMatchObject({ visible: true, icon: 'warning' });
    expect(v.tooltip).toBe(`Conduit — 3 agents running. ${text}`);
    expect(labels(v)).toEqual(['3 agents running', text]);
  });

  it('exhausted shows the retry time as HH:MM', () => {
    const iso = '2026-11-03T14:05:00.000Z';
    const d = new Date(iso);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const v = view({ phase: 'exhausted', retryAt: iso }, hc(2));
    expect(v.visible).toBe(true);
    expect(labels(v).at(-1)).toBe(
      `Background service stopped after repeated crashes. Retrying at ${hhmm}.`,
    );
  });

  it.each([
    [{ phase: 'spawning' } as ServicePhase],
    [{ phase: 'restarting' } as ServicePhase],
    [{ phase: 'exhausted', retryAt: '2026-11-03T14:05:00.000Z' } as ServicePhase],
  ])('%j with hc 0 or none is hidden', (phase) => {
    expect(view(phase, hc(0)).visible).toBe(false);
    expect(view(phase, { source: 'none' }).visible).toBe(false);
  });

  it('stopping stays visible if agents were showing, hidden otherwise', () => {
    expect(view({ phase: 'stopping' }, server())).toMatchObject({
      visible: true,
      icon: 'normal',
      tooltip: 'Conduit — Stopping agents…',
    });
    expect(view({ phase: 'stopping' }, server({ running: 0 })).visible).toBe(false);
    expect(view({ phase: 'stopping' }, { source: 'none' }).visible).toBe(false);
  });

  it('counts.stopping behaves like the stopping phase', () => {
    expect(view(serving, server({ stopping: 'stopAll' })).tooltip).toBe(
      'Conduit — Stopping agents…',
    );
  });

  it('menu order, with Stop all disabled only while stopping', () => {
    const v = view(serving, server({ needsYou: 1, health: 'degraded' }), 'Conduit (dev)');
    expect(v.items.map((i) => (i.kind === 'action' ? i.id : i.kind))).toEqual([
      'label',
      'label',
      'label',
      'label',
      'separator',
      'open',
      'stopAll',
    ]);
    expect(labels(v)).toEqual([
      'Conduit (dev)',
      '3 agents running',
      '1 needs you',
      'Background service degraded',
    ]);
    expect(stopAll(v)).toMatchObject({ enabled: true });
    expect(stopAll(view({ phase: 'stopping' }, server()))).toMatchObject({ enabled: false });
  });

  it('open is the only default', () => {
    const defaults = view(serving, server()).items.filter(
      (i) => i.kind === 'action' && i.isDefault,
    );
    expect(defaults).toEqual([
      { kind: 'action', id: 'open', text: 'Open Conduit', enabled: true, isDefault: true },
    ]);
  });

  it('confirm body with and without the needs-you clause', () => {
    expect(view(serving, server({ needsYou: 1 })).confirm).toEqual({
      title: 'Stop all agents?',
      body: "3 agents are running in Conduit's background service (1 needs you). Stopping ends them. Anything they haven't saved is lost.",
      confirm: 'Stop all agents',
      cancel: 'Cancel',
    });
    expect(view(serving, server()).confirm.body).toBe(
      "3 agents are running in Conduit's background service. Stopping ends them. Anything they haven't saved is lost.",
    );
    expect(view(serving, hc(3)).confirm.body).not.toContain('needs you');
  });

  it('tooltip never exceeds 127 UTF-16 units or splits a surrogate pair', () => {
    const long = view(
      serving,
      server({ health: 'degraded', needsYou: 1 }),
      `Conduit (${'😀'.repeat(80)})`,
    );
    expect(long.tooltip.length).toBeLessThanOrEqual(127);
    expect(long.tooltip.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(long.tooltip.slice(0, -1))).toBe(false);
  });

  it('profileLabel null vs set leads the menu and the tooltip', () => {
    expect(labels(view(serving, server()))[0]).toBe('3 agents running');
    const v = view(serving, server(), 'Conduit (dev)');
    expect(labels(v)[0]).toBe('Conduit (dev)');
    expect(v.tooltip.startsWith('Conduit (dev) — ')).toBe(true);
  });
});

describe('profileLabelOf', () => {
  const appData = 'C:\\Users\\a\\AppData\\Roaming';
  it('is null for the default userData, any case or trailing separator', () => {
    expect(profileLabelOf(`${appData}\\Conduit`, appData, '\\')).toBeNull();
    expect(profileLabelOf('c:\\users\\a\\appdata\\roaming\\conduit\\', appData, '\\')).toBeNull();
    expect(profileLabelOf('/r/Conduit', '/r', '/')).toBeNull();
  });
  it('uses the userData leaf otherwise', () => {
    expect(profileLabelOf(`${appData}\\Conduit-dev`, appData, '\\')).toBe('Conduit (Conduit-dev)');
    expect(profileLabelOf('/x/y/work', '/r', '/')).toBe('Conduit (work)');
  });
});
