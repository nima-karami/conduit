import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/types';
import {
  AgentMark,
  AgentRow,
  type AgentRowModel,
  AgentRowPreview,
} from '../../webview/components/session-card';

const noop = () => {};
const NOW = 10 * 60_000;

function session(o: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'api fix',
    agentId: 'claude',
    home: 'G:/work/api',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...o,
  };
}

const ROW: AgentRowModel = {
  depth: 0,
  state: 'idle',
  effectiveState: 'idle',
  stateSince: NOW - 3 * 60_000,
  childIds: [],
  descendantCount: 0,
  childState: null,
  folded: false,
};

function row(
  o: {
    s?: Partial<Session>;
    row?: Partial<AgentRowModel>;
    selected?: boolean;
    pinned?: boolean;
    space?: string;
    editing?: boolean;
    guides?: boolean[];
    lastChild?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    createElement(AgentRow, {
      session: session(o.s),
      row: { ...ROW, ...o.row },
      icon: { type: 'kind', kind: 'claude' },
      label: 'api fix, Idle',
      tooltip: 'api fix\nIdle',
      space: o.space,
      now: NOW,
      selected: o.selected ?? false,
      tabbable: true,
      pinned: o.pinned ?? false,
      guides: o.guides ?? [],
      lastChild: o.lastChild ?? true,
      editing: o.editing ?? false,
      onEditStart: noop,
      onEditEnd: noop,
      onRename: noop,
      onSelect: noop,
      onPin: noop,
      onClose: noop,
      onRelaunch: noop,
      onFold: noop,
    }),
  );
}

const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

describe('AgentRow — the selector contract', () => {
  it('is a .session treeitem keyed by data-sessionid with level, selection and label', () => {
    const html = row();
    expect(html).toMatch(/^<div class="session session--root"/);
    expect(attr(html, 'role')).toBe('treeitem');
    expect(attr(html, 'data-sessionid')).toBe('s1');
    // Level 1 is the group header of the flat tree.
    expect(attr(html, 'aria-level')).toBe('2');
    expect(attr(html, 'aria-selected')).toBe('false');
    expect(attr(html, 'aria-label')).toBe('api fix, Idle');
    expect(html).not.toContain('aria-expanded');
  });

  it('a child is one level deeper and carries the child class', () => {
    const html = row({ row: { depth: 2 } });
    expect(html).toContain('session session--child');
    expect(attr(html, 'aria-level')).toBe('4');
  });

  it('the select button is labelled Go to and holds the name; no button nests in a button', () => {
    const html = row();
    expect(html).toMatch(
      /<button type="button" class="session__select" data-agent-action="select" aria-label="Go to api fix" tabindex="-1">/,
    );
    expect(html).toContain('<span class="session__name">api fix</span>');
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/s);
  });

  it('pin, close and relaunch carry their actions and labels', () => {
    const stale = row({ s: { status: 'stale' } });
    expect(stale).toMatch(/data-agent-action="relaunch" aria-label="Relaunch api fix"/);
    expect(stale).toMatch(/data-agent-action="pin" aria-label="Pin to top"/);
    expect(stale).toMatch(
      /class="session__kill" data-agent-action="close" aria-label="Close api fix"/,
    );
    expect(row({ pinned: true })).toMatch(/data-agent-action="pin" aria-label="Unpin"/);
    // Running, or a home that is gone, offers no relaunch.
    expect(row()).not.toContain('data-agent-action="relaunch"');
    expect(row({ s: { status: 'stale', homeMissing: true } })).not.toContain('session__relaunch');
  });

  it('a row with children has a fold control and aria-expanded on both', () => {
    const open = row({ row: { childIds: ['c'], descendantCount: 1, childState: 'working' } });
    expect(attr(open, 'aria-expanded')).toBe('true');
    expect(open).toMatch(
      /data-agent-action="fold" aria-expanded="true" aria-label="Hide sub-agents"/,
    );
    const folded = row({
      row: { childIds: ['c'], descendantCount: 3, childState: 'blocked', folded: true },
    });
    expect(attr(folded, 'aria-expanded')).toBe('false');
    expect(folded).toMatch(/aria-label="Show sub-agents" title="3 hidden sub-agents"/);
    expect(folded).toContain('<span class="session__kids session__kids--blocked">3</span>');
  });

  it('shows the Space only when given, and the own age', () => {
    expect(row({ space: 'Conduit' })).toContain('<span class="session__space"> · Conduit</span>');
    expect(row()).not.toContain('session__space');
    expect(row()).toContain('<span class="session__age" aria-hidden="true">3m</span>');
  });

  it('selection and attention are distinct classes, and selection wins outright', () => {
    expect(row({ selected: true })).toContain('session--active');
    expect(attr(row({ selected: true }), 'aria-selected')).toBe('true');
    expect(row({ row: { effectiveState: 'blocked' } })).toContain('session--attention');
    const both = row({ selected: true, row: { effectiveState: 'blocked' } });
    expect(both).toContain('session--active');
    expect(both).not.toContain('session--attention');
  });

  it('renaming swaps the select button for the .session__edit input', () => {
    const html = row({ editing: true });
    expect(html).toContain('class="session__edit"');
    expect(html).not.toContain('data-agent-action="select"');
    expect(html).not.toContain('session__kill');
  });

  it('draws a guide per continuing ancestor level and an elbow into a child', () => {
    const html = row({ row: { depth: 2 }, guides: [true], lastChild: false });
    expect(html.match(/session__guide/g)).toHaveLength(1);
    expect(html).toContain('session__elbow session__elbow--through');
    expect(row({ row: { depth: 1 } })).toContain('class="session__elbow"');
    expect(row()).not.toContain('session__elbow');
  });
});

describe('AgentMark', () => {
  it('Working spins; every other state is a dot with its own modifier and tooltip', () => {
    const working = renderToStaticMarkup(createElement(AgentMark, { state: 'working' }));
    expect(working).toContain('agentmark__spin');
    expect(working).toContain('title="Working"');
    for (const state of ['blocked', 'done', 'idle', 'stopped'] as const) {
      const html = renderToStaticMarkup(createElement(AgentMark, { state }));
      expect(html, state).toContain(`agentmark__dot agentmark__dot--${state}`);
    }
    expect(renderToStaticMarkup(createElement(AgentMark, { state: 'done' }))).toContain(
      'title="Done, not seen yet"',
    );
  });
});

describe('AgentRowPreview', () => {
  it('is a real, inert, selected agent row', () => {
    const html = renderToStaticMarkup(createElement(AgentRowPreview));
    expect(html).toMatch(/^<div class="cardcfg__card" inert="">/);
    expect(html).toContain('session--active');
    expect(html).toContain('Portfolio Redesign');
    expect(html).toContain('agentmark__spin');
  });
});

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
const rule = (selector: string) => {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
};

describe('agent row CSS', () => {
  it('defines the row, elbow and tile tokens it reads, per density and per theme', () => {
    const block = (head: string) => {
      const at = CSS.indexOf(head);
      expect(at, head).toBeGreaterThan(-1);
      return CSS.slice(at, CSS.indexOf('\n}', at));
    };
    const compact = block(':root[data-density="compact"] {');
    const neon = block(':root[data-theme="neon"] {');
    expect(CSS).toContain('\n  --density-agent-row-h: 30px;');
    expect(CSS).toContain('\n  --density-agent-child-h: 26px;');
    expect(compact).toContain('--density-agent-row-h: 26px;');
    expect(compact).not.toContain('--density-agent-child-h');
    expect(CSS).toContain('\n  --r-space-tile: 5px;');
    expect(CSS).toContain('\n  --r-tree-elbow: 6px;');
    expect(neon).toContain('--r-space-tile: 0px;');
    expect(neon).toContain('--r-tree-elbow: 0px;');
  });

  it('rows and Spaces take their heights from density, never a theme block', () => {
    expect(rule('.session')).toContain('height: var(--density-agent-row-h)');
    expect(rule('.session--child')).toContain('height: var(--density-agent-child-h)');
    expect(rule('.space')).toContain('height: var(--density-agent-row-h)');
    const themed = [...CSS.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(
      ([, sel, body]) =>
        sel.includes('[data-theme') &&
        !sel.includes('.chamfer') &&
        /\.(session|space)\b/.test(sel) &&
        /(^|[\s;])height:/.test(body),
    );
    expect(themed.map(([, sel]) => sel.trim())).toEqual([]);
  });

  it('flat at rest, selection is the selection fill and accent edge', () => {
    expect(rule('.session')).toContain('background: transparent');
    expect(rule('.session--active')).toContain('--notch-line: var(--accent)');
    expect(rule('.session--active')).toContain('background: var(--state-sel-bg)');
  });

  it('Neon chamfers only selected and attention rows', () => {
    const chamfer = CSS.slice(CSS.indexOf('the Neon chamfer'), CSS.indexOf('Neon shell:'));
    expect(chamfer).not.toMatch(/[(,\s]\.session[,\s)]/);
    expect(chamfer).toContain('.session--active');
    expect(chamfer).toContain('.session--attention');
  });

  it('reduced motion stills the Working spinner', () => {
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.agentmark__spin \{\s*animation: none;/,
    );
  });

  it('the old card surfaces are gone', () => {
    for (const gone of [
      '.session__state',
      '.session__meta',
      '.session__ask',
      '.session__btn',
      '.session__timer',
      '.session__mcp',
      '.sidebar__update',
      '.proj__add',
    ])
      expect(CSS, gone).not.toContain(`\n${gone} {`);
  });
});
