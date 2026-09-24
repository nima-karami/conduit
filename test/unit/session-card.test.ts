import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/types';
import {
  type CardRoles,
  SessionCard,
  SessionCardPreview,
} from '../../webview/components/session-card';

const noop = () => {};
const ROLES: CardRoles = { title: 'name', subtitle: 'agent', detail: 'none' };

function session(o: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'api fix',
    agentId: 'claude',
    home: 'G:/work/api',
    roots: [],
    status: 'running',
    createdAt: Date.now() - 600_000,
    lastActiveAt: Date.now() - 600_000,
    lastLine: 'Edit src/main.ts',
    ...o,
  };
}

const card = (s: Session, roles: CardRoles = ROLES) =>
  renderToStaticMarkup(
    createElement(SessionCard, {
      session: s,
      agentLabel: 'claude',
      resolvedIcon: { type: 'kind', kind: 'claude' },
      active: false,
      onSelect: noop,
      onKill: noop,
      onRename: noop,
      onRelaunch: noop,
      onSnooze: noop,
      editing: false,
      onEditStart: noop,
      onEditEnd: noop,
      roles,
    }),
  );

describe('SessionCard (9b)', () => {
  it('idle card: glyph, name, agent subtitle by default, pill "Idle", no age/meter/diffstat', () => {
    const html = card(session());
    expect(html).toContain('session--idle');
    expect(html).toContain('session__icon');
    expect(html).toContain('>api fix<');
    expect(html).toContain('session__metaitem">claude<');
    expect(html).toContain('session__state">Idle');
    expect(html).not.toContain('session__age');
    expect(html).not.toContain('session__meter');
    expect(html).not.toContain('session__diffstat');
    expect(html).not.toContain('Edit src/main.ts');
  });

  it('busy card has no meter', () => {
    const html = card(session({ busy: true }));
    expect(html).toContain('session__state">Busy');
    expect(html).not.toContain('session__meter');
    expect(html).not.toContain('progressbar');
  });

  it('× is labelled Close session', () => {
    const html = card(session());
    const kill = html.match(/<button[^>]*class="session__kill"[^>]*>/)?.[0] ?? '';
    expect(kill).toContain('aria-label="Close session"');
    expect(kill).toContain('title="Close session"');
    expect(html).not.toContain('✕');
  });

  it('attention card shows Go to and Snooze', () => {
    const html = card(session({ needsAttention: true }));
    expect(html).toContain('session__state">Needs you');
    expect(html).toContain('>Go to<');
    expect(html).toContain('>Snooze<');
  });

  it('stale card shows ↻', () => {
    const html = card(session({ status: 'stale' }));
    expect(html).toContain('session__state">Stale');
    expect(html).toContain('session__relaunch');
    expect(html).toContain('↻');
    expect(card(session())).not.toContain('session__relaunch');
  });

  it('review card shows the Review pill and no diffstat button', () => {
    const html = card(
      session({
        completedRun: true,
        repoGit: {
          'G:/work/api': { kind: 'branch', branch: 'main', dirty: true, dirtyFiles: 3 },
        },
      }),
    );
    expect(html).toContain('session__state">Review');
    expect(html).not.toContain('session__diffstat');
    expect(html).not.toContain('Review changes');
  });
});

describe('SessionCardPreview', () => {
  it('SessionCardPreview renders a session__state pill and the agent line for roles {name, agent, none}', () => {
    const html = renderToStaticMarkup(
      createElement(SessionCardPreview, {
        roles: { title: 'name', subtitle: 'agent', detail: 'none' },
      }),
    );
    expect(html).toMatch(/^<div class="cardcfg__card" inert="">/);
    expect(html).toContain('session--active');
    expect(html).toContain('>Portfolio Redesign<');
    expect(html).toContain('session__metaitem">PowerShell 7<');
    expect(html).toContain('session__state">Idle');
    expect(html).toContain('session__icon');
    expect(html).not.toContain('session__meter');
    expect(html).not.toContain('session__path');
  });

  it('follows the roles it is given', () => {
    const html = renderToStaticMarkup(
      createElement(SessionCardPreview, {
        roles: { title: 'folder', subtitle: 'live', detail: 'worktree' },
      }),
    );
    expect(html).toContain('>nextjs-portfolio<');
    expect(html).toContain('session__metaitem">Edit webview/styles.css<');
    expect(html).toContain('session__path');
    expect(html).toContain('feature/auth');
  });
});
