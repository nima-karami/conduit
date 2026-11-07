// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type AgentsView,
  DEFAULT_AGENTS_VIEW,
  DEFAULT_SPACES_VIEW,
  type SpacesView,
} from '../../src/sidebar-view';
import type { Session } from '../../src/types';
import { ViewMenu } from '../../webview/components/view-menu';
import {
  agentViewCounts,
  buildAgentsViewMenu,
  buildSpacesViewMenu,
} from '../../webview/sidebar-view-menu';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const click = async (el: Element | null | undefined) =>
  act(async () => (el as HTMLElement).click());
const names = (sel: string) => qa(sel).map((e) => e.textContent);
async function key(k: string, el: Element = document.activeElement ?? document.body) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

const COUNTS = { running: 3, needsYou: 1 };

/** The Agents menu on its own state, the way the sidebar drives it. */
async function renderAgents(initial: Partial<AgentsView> = {}) {
  const seen: AgentsView[] = [];
  function Harness() {
    const [view, setView] = useState<AgentsView>({ ...DEFAULT_AGENTS_VIEW, ...initial });
    return createElement(ViewMenu, {
      label: 'Agents view options',
      model: buildAgentsViewMenu(view, COUNTS, (next) => {
        seen.push(next);
        setView(next);
      }),
    });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(Harness)));
  return seen;
}
const trigger = () => q<HTMLButtonElement>('button.viewmenu__trigger');
const open = async () => click(trigger());
const item = (label: string) =>
  qa<HTMLButtonElement>('[role^="menuitem"]').find((e) => e.textContent?.startsWith(label)) as
    | HTMLButtonElement
    | undefined;

describe('buildAgentsViewMenu', () => {
  const build = (v: Partial<AgentsView> = {}) =>
    buildAgentsViewMenu({ ...DEFAULT_AGENTS_VIEW, ...v }, COUNTS, () => {});

  it('has Sort, Group and Filter with the lead decisions options', () => {
    const m = build();
    expect(m.sections.map((s) => [s.label, s.kind, s.options.map((o) => o.label)])).toEqual([
      ['Sort', 'radio', ['Recent activity', 'Name', 'Status', 'Created']],
      ['Group', 'radio', ['By status', 'By space', 'By agent type', 'None']],
      ['Filter', 'check', ['Running only', 'Needs you']],
    ]);
    expect(m.sections[2].chips?.items.map((c) => c.label)).toEqual([
      'Claude',
      'Codex',
      'Cursor',
      'Other',
    ]);
  });

  it('checks the current choice, and the defaults are Recent activity / By status', () => {
    const m = build();
    const checked = m.sections.flatMap((s) => s.options.filter((o) => o.checked).map((o) => o.id));
    expect(checked).toEqual(['recent', 'status']);
    expect(m.reset).toBeNull();
  });

  it('offers Reset only once something differs, and Reset restores the defaults', () => {
    const onChange = vi.fn();
    const m = buildAgentsViewMenu(
      { ...DEFAULT_AGENTS_VIEW, group: 'type', kinds: ['codex'] },
      COUNTS,
      onChange,
    );
    m.reset?.();
    expect(onChange).toHaveBeenCalledWith(DEFAULT_AGENTS_VIEW);
  });

  it('shows what each filter would keep, and nothing when it keeps none', () => {
    expect(build().sections[2].options.map((o) => o.hint)).toEqual(['3', '1']);
    const none = buildAgentsViewMenu(DEFAULT_AGENTS_VIEW, { running: 0, needsYou: 0 }, () => {});
    expect(none.sections[2].options.map((o) => o.hint)).toEqual([undefined, undefined]);
  });
});

describe('agentViewCounts', () => {
  const sess = (id: string, over: Partial<Session> = {}): Session => ({
    id,
    name: id,
    agentId: 'a',
    home: '/w',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    attentionReason: null,
    completions: 0,
    ...over,
  });
  const all = [
    sess('a', { projectId: 'p1' }),
    sess('b', { projectId: 'p1', attentionReason: 'blocked' }),
    sess('c', { projectId: 'p2', attentionReason: 'blocked' }),
    sess('d', { projectId: 'p2', status: 'exited' }),
  ];
  const runtime = { seen: {}, stateSince: {} };
  const every = new Set(all.map((s) => s.id));

  it('counts every running agent when nothing narrows the list', () => {
    expect(
      agentViewCounts(all, runtime, new Set(), { selection: { kind: 'all' }, matchingIds: every }),
    ).toEqual({ running: 3, needsYou: 2 });
  });

  it('counts only the selected Space and the current search', () => {
    expect(
      agentViewCounts(all, runtime, new Set(), {
        selection: { kind: 'space', projectId: 'p1' },
        matchingIds: every,
      }),
    ).toEqual({ running: 2, needsYou: 1 });
    expect(
      agentViewCounts(all, runtime, new Set(), {
        selection: { kind: 'all' },
        matchingIds: new Set(['a', 'c']),
      }),
    ).toEqual({ running: 2, needsYou: 1 });
  });
});

describe('buildSpacesViewMenu', () => {
  it('has Sort (Manual, Name, Recent) and Filter (Hide empty spaces)', () => {
    const m = buildSpacesViewMenu(DEFAULT_SPACES_VIEW, () => {});
    expect(m.sections.map((s) => [s.label, s.options.map((o) => o.label)])).toEqual([
      ['Sort', ['Manual', 'Name', 'Recent']],
      ['Filter', ['Hide empty spaces']],
    ]);
    expect(m.reset).toBeNull();
  });

  it('Reset restores the defaults', () => {
    const onChange = vi.fn();
    const v: SpacesView = { sort: 'name', hideEmpty: true };
    buildSpacesViewMenu(v, onChange).reset?.();
    expect(onChange).toHaveBeenCalledWith(DEFAULT_SPACES_VIEW);
  });
});

describe('ViewMenu', () => {
  it('is a closed menu button at rest, with no dot at the defaults', async () => {
    await renderAgents();
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-label')).toBe('Agents view options');
    expect(q('.viewmenu__dot')).toBeNull();
    expect(q('[role="menu"]')).toBeNull();
  });

  it('shows a dot and says so when an option is not the default', async () => {
    await renderAgents({ runningOnly: true });
    expect(q('.viewmenu__dot')).not.toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Agents view options, customized');
  });

  it('opens on click with the sections, radios, checkboxes and chips', async () => {
    await renderAgents();
    await open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const menu = q('[role="menu"]');
    expect(menu.parentElement).toBe(document.body);
    expect(names('.viewmenu__label')).toEqual(['Sort', 'Group', 'Filter']);
    expect(qa('[role="menuitemradio"]')).toHaveLength(8);
    expect(qa('[role="menuitemcheckbox"]')).toHaveLength(2 + 4);
    expect(item('Recent activity')?.getAttribute('aria-checked')).toBe('true');
    expect(item('Name')?.getAttribute('aria-checked')).toBe('false');
    expect(item('By status')?.getAttribute('aria-checked')).toBe('true');
    expect(item('Running only')?.getAttribute('aria-checked')).toBe('false');
    expect(item('Claude')?.getAttribute('aria-checked')).toBe('false');
  });

  it('applies a pick at once and stays open for the next', async () => {
    const seen = await renderAgents();
    await open();
    await click(item('Name'));
    await click(item('By agent type'));
    await click(item('Running only'));
    await click(item('Codex'));
    expect(seen.at(-1)).toEqual({
      sort: 'name',
      group: 'type',
      runningOnly: true,
      needsYou: false,
      kinds: ['codex'],
    });
    expect(q('[role="menu"]')).not.toBeNull();
    expect(item('Name')?.getAttribute('aria-checked')).toBe('true');
    expect(item('Recent activity')?.getAttribute('aria-checked')).toBe('false');
    expect(item('Codex')?.getAttribute('aria-checked')).toBe('true');
    expect(q('.viewmenu__dot')).not.toBeNull();
  });

  it('chips are multi-select', async () => {
    await renderAgents();
    await open();
    await click(item('Claude'));
    await click(item('Cursor'));
    expect(['Claude', 'Codex', 'Cursor', 'Other'].map((l) => item(l)?.ariaChecked)).toEqual([
      'true',
      'false',
      'true',
      'false',
    ]);
    await click(item('Claude'));
    expect(item('Claude')?.getAttribute('aria-checked')).toBe('false');
  });

  it('Reset sits in the first section row, only when something differs, and restores the defaults', async () => {
    const seen = await renderAgents({ sort: 'name', kinds: ['claude'] });
    await open();
    const reset = q('.viewmenu__section .viewmenu__reset');
    expect(
      reset.closest('.viewmenu__section')?.querySelector('.viewmenu__label')?.textContent,
    ).toBe('Sort');
    await click(reset);
    expect(seen.at(-1)).toEqual(DEFAULT_AGENTS_VIEW);
    expect(q('.viewmenu__reset')).toBeNull();
    expect(q('.viewmenu__dot')).toBeNull();
    expect(q('[role="menu"]')).not.toBeNull();
  });

  it('has no Reset at the defaults', async () => {
    await renderAgents();
    await open();
    expect(q('.viewmenu__reset')).toBeNull();
  });

  it('opens with focus on the first choice; arrows move through every row and wrap', async () => {
    await renderAgents();
    await open();
    expect(document.activeElement).toBe(item('Recent activity'));
    await key('ArrowDown');
    expect(document.activeElement).toBe(item('Name'));
    await key('End');
    expect(document.activeElement).toBe(item('Other'));
    await key('ArrowDown');
    expect(document.activeElement).toBe(item('Recent activity'));
    await key('ArrowUp');
    expect(document.activeElement).toBe(item('Other'));
    await key('Home');
    expect(document.activeElement).toBe(item('Recent activity'));
  });

  it('every choice is a real button, so Enter and Space toggle it natively', async () => {
    await renderAgents();
    await open();
    for (const el of qa('[role^="menuitem"]')) expect(el.tagName).toBe('BUTTON');
  });

  it('Escape closes and returns focus to the trigger', async () => {
    await renderAgents();
    await open();
    await key('Escape', document.activeElement ?? document.body);
    expect(q('[role="menu"]')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('an outside pointer dismissal leaves focus where the click put it', async () => {
    await renderAgents();
    await open();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    await act(async () => {
      elsewhere.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      elsewhere.focus();
    });
    expect(q('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(trigger());
  });

  it('clicking the trigger again closes it', async () => {
    await renderAgents();
    await open();
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await click(trigger());
    expect(q('[role="menu"]')).toBeNull();
  });
});
