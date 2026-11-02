import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildAgentTree } from '../../src/agent-tree';
import { attentionEntries, attentionSessions } from '../../src/attention';
import { orderSessions } from '../../src/session-groups';
import { sessionIconState } from '../../src/session-icon';
import { advanceAgentRuntime, defaultSidebarUi } from '../../src/sidebar-state';
import type { Session, SessionIconKind } from '../../src/types';
import { SessionGlyph } from '../../webview/icons';

/**
 * Compatibility pins for the Spaces and agent tree change (docs/plans/2026-11-02-sidebar-agent-tree.plan.md
 * S0): old records and legacy consumers keep working, and the DOM/ARIA contract G1/G2 implement
 * stays the one the plan states.
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** A record as an older app or a hand-edited file has it: no server facts at all. */
const legacy = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  name: id,
  agentId: 'claude',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  ...over,
});

describe('legacy records', () => {
  it('build a tree with neutral facts: no spurious Needs you or Done', () => {
    const sessions = [legacy('a', { needsAttention: true, completedRun: true }), legacy('b')];
    const runtime = advanceAgentRuntime({
      previous: null,
      before: [],
      sessions,
      previousAskSessionIds: new Set(),
      askSessionIds: new Set(),
      viewedTerminalIds: new Set(),
      now: 1,
    });
    const t = buildAgentTree({
      sessions,
      runtime,
      ui: defaultSidebarUi(),
      matchingIds: new Set(['a', 'b']),
      askSessionIds: new Set(),
    });
    expect(t.rows.a.state).toBe('idle');
    expect(runtime.seen).toEqual({ a: 0, b: 0 });
  });

  it('legacy appIcon literals stay valid kinds and every kind has a glyph', () => {
    const kinds: SessionIconKind[] = [
      'claude',
      'powershell',
      'terminal',
      'codex',
      'opencode',
      'cursor',
      'gemini',
    ];
    for (const kind of kinds) {
      const html = renderToStaticMarkup(
        createElement(SessionGlyph, { icon: { type: 'kind', kind } }),
      );
      expect(html, kind).toMatch(/<svg/);
    }
  });
});

describe('legacy consumers ignore the new facts', () => {
  const blockedOnly = legacy('x', { attentionReason: 'blocked' });
  const finished = legacy('y', { needsAttention: true });

  it('sessionIconState, attentionSessions and attentionEntries still read needsAttention', () => {
    expect(sessionIconState(blockedOnly)).toBe('idle');
    expect(sessionIconState(finished)).toBe('attention');
    expect(attentionSessions([blockedOnly, finished]).map((s) => s.id)).toEqual(['y']);
    expect(attentionEntries([blockedOnly, finished], [], new Map(), 0).map((e) => e.key)).toEqual([
      'session:y',
    ]);
  });

  it('legacy grouping still floats needsAttention', () => {
    expect(orderSessions([blockedOnly, finished], 'name', []).map((s) => s.id)).toEqual(['y', 'x']);
  });
});

/**
 * The selector contract G1/G2 build to and G4 migrates onto (plan "S0 DOM/ARIA selector
 * contract"). Each surface lists the literal fragments the plan row must keep.
 */
const SELECTOR_CONTRACT: Record<string, readonly string[]> = {
  'Agent tree': ['`[data-agent-tree]`', 'role=tree', 'aria-label="Agents"'],
  Row: [
    '`.session[data-sessionid="<id>"]`',
    'role=treeitem',
    'aria-level=depth+1',
    'aria-selected=true/false',
    'Working/Needs you/Done/Idle/Stopped',
  ],
  'Row content/actions': [
    '`.session__name`',
    '`.session__edit`',
    'data-agent-action=select',
    'aria-label="Go to <name>"',
    'Pin to top/Unpin/Close <name>/Relaunch <name>/Show sub-agents/Hide sub-agents',
  ],
  Space: [
    'button[data-space-id="all|no-space|<projectId>"]',
    'aria-pressed',
    'aria-label="All"/"No space"',
  ],
  Group: [
    'button.proj__label[data-agent-group="pinned|blocked|done|working|idle|stopped"]',
    'aria-expanded',
    'aria-label="<label> (<root count>)"',
    'role=group',
  ],
  'Header toggles': [
    'button[data-right-view="files|changes|messages"]',
    'aria-label="Files|Changes|Messages"',
    'aria-pressed=true/false',
    'aria-controls="right-pane"',
  ],
  'Right panel': [
    'aside#right-pane[data-right-view="files|changes|messages"]',
    'aria-label="Files|Changes|Messages"',
  ],
  Footer: [
    'footer[data-status-bar]',
    'aria-label="Session status"',
    'data-status-item="machine|branch|worktree|live|attention|commands"',
    'attentionChipLabel',
  ],
  'Update outlet/item': [
    'aria-label="Notifications"',
    'data-toast-stack',
    '.update-card[data-update-toast]',
    'data-update-state="available|downloading|ready"',
    'aria-label="Dismiss update"',
    'aria-label="Update download"',
  ],
  'Announcements/filter': ['input.sessbar__filter', 'aria-label="Filter sessions"'],
};

describe('S0 DOM/ARIA selector contract', () => {
  const plan = read('docs/plans/2026-11-02-sidebar-agent-tree.plan.md');
  const rows = new Map(
    [...plan.matchAll(/^\| ([^|]+?) \| (.+) \|$/gm)].map((m) => [m[1].trim(), m[2]] as const),
  );

  for (const [surface, fragments] of Object.entries(SELECTOR_CONTRACT)) {
    it(`${surface}: the plan row still states the contract`, () => {
      const row = rows.get(surface);
      expect(row, surface).toBeDefined();
      for (const f of fragments) expect(row, f).toContain(f);
    });
  }

  it('the preserved row selector is the one the card renders today', () => {
    // data-sessionid, never a guessed data-session-id (spec §2 grounding).
    expect(read('webview/components/session-card.tsx')).toContain('data-sessionid=');
    expect(read('webview/app.tsx')).toContain('.session[data-sessionid=');
  });
});
