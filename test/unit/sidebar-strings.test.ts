import { describe, expect, it } from 'vitest';
import type { AgentGroup, AgentState } from '../../src/sidebar-state';
import { SIDEBAR_STR } from '../../webview/sidebar-strings';

const STATES: AgentState[] = ['blocked', 'done', 'working', 'idle', 'stopped'];

describe('SIDEBAR_STR', () => {
  it('names the five states exactly as the selector contract reads them', () => {
    expect(STATES.map(SIDEBAR_STR.state)).toEqual([
      'Needs you',
      'Done',
      'Working',
      'Idle',
      'Stopped',
    ]);
  });

  it('every state has a distinct word, so no state is colour alone', () => {
    expect(new Set(STATES.map(SIDEBAR_STR.state)).size).toBe(STATES.length);
    expect(new Set(STATES.map(SIDEBAR_STR.markTip)).size).toBe(STATES.length);
  });

  it('group labels count roots: "<label> (<root count>)"', () => {
    const groups: AgentGroup[] = ['pinned', ...STATES];
    expect(groups.map((g) => SIDEBAR_STR.groupLabel(g, 2))).toEqual([
      'Pinned (2)',
      'Needs you (2)',
      'Done (2)',
      'Working (2)',
      'Idle (2)',
      'Stopped (2)',
    ]);
  });

  it('counts are plural-aware for 0, 1 and many', () => {
    expect(SIDEBAR_STR.agentCount(0)).toBe('0 agents');
    expect(SIDEBAR_STR.agentCount(1)).toBe('1 agent');
    expect(SIDEBAR_STR.agentCount(5)).toBe('5 agents');
    expect(SIDEBAR_STR.hiddenKids(1)).toBe('1 hidden sub-agent');
    expect(SIDEBAR_STR.hiddenKids(3)).toBe('3 hidden sub-agents');
    expect(SIDEBAR_STR.menu.snooze(1)).toBe('Snooze for 1 minute');
    expect(SIDEBAR_STR.menu.snooze(10)).toBe('Snooze for 10 minutes');
  });

  it('formats large counts with the locale separator', () => {
    expect(SIDEBAR_STR.agentCount(12_345)).toBe(`${(12_345).toLocaleString()} agents`);
  });

  it('row label: name, status, the Space when given, then a descendant ask last', () => {
    expect(
      SIDEBAR_STR.rowLabel({ name: 'lead', state: 'working', descendantNeedsYou: false }),
    ).toBe('lead, Working');
    expect(
      SIDEBAR_STR.rowLabel({
        name: 'lead',
        state: 'idle',
        space: 'Conduit',
        descendantNeedsYou: true,
      }),
    ).toBe('lead, Idle, Conduit, a sub-agent needs you');
  });

  it('keeps user names verbatim in action labels', () => {
    const name = 'fix: “quotes” & <tags>';
    expect(SIDEBAR_STR.goTo(name)).toBe(`Go to ${name}`);
    expect(SIDEBAR_STR.close(name)).toBe(`Close ${name}`);
    expect(SIDEBAR_STR.relaunch(name)).toBe(`Relaunch ${name}`);
    expect(SIDEBAR_STR.noMatch(name)).toBe(`No sessions match “${name}”`);
  });

  it('visible copy says Space, never project', () => {
    const flat = JSON.stringify(SIDEBAR_STR);
    expect(flat).not.toMatch(/project/i);
    expect(SIDEBAR_STR.all).toBe('All');
    expect(SIDEBAR_STR.noSpace).toBe('No space');
    expect(SIDEBAR_STR.menu.moveSpace).toBe('Move to space…');
  });
});
