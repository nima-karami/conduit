import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adapterFor,
  MCP_ADAPTERS,
  type McpAdapter,
  notifiable,
} from '../../src/conduit-mcp/adapters';
import {
  NOTICE_ECHO_ROWS,
  type ScreenSnapshot,
  screenVerdict,
} from '../../src/conduit-mcp/screen-verdict';

const SCREENS = path.join(__dirname, 'fixtures', 'conduit-mcp', 'screens');
function screen(name: string): ScreenSnapshot {
  const j = JSON.parse(fs.readFileSync(path.join(SCREENS, `${name}.json`), 'utf8')) as {
    lines: string[];
    cursorY: number;
    styles?: string[];
  };
  return { lines: j.lines, cursorY: j.cursorY, styles: j.styles };
}
function adapter(id: McpAdapter['id']): McpAdapter {
  const a = MCP_ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(`no adapter ${id}`);
  return a;
}
const claude = adapter('claude');
const NOTICE = '[conduit] New messages for you. Use the conduit read_inbox tool.';

describe('adapterFor', () => {
  const def = (id: string, command: string) => ({ id, command });
  it('matches by command leaf', () => {
    expect(adapterFor(def('cli:claude', 'C:/x/claude.exe'), { e2e: false })?.id).toBe('claude');
    expect(adapterFor(def('cli:codex', '/usr/bin/codex'), { e2e: false })?.id).toBe('codex');
    expect(adapterFor(def('a', 'C:\\bin\\cursor-agent.cmd'), { e2e: false })?.id).toBe('cursor');
    expect(adapterFor(def('b', 'agent'), { e2e: false })?.id).toBe('cursor');
  });
  it('the fake adapter matches its id only under e2e', () => {
    expect(adapterFor(def('e2e-fake-mcp', 'node'), { e2e: true })?.id).toBe('fake');
    expect(adapterFor(def('e2e-fake-mcp', 'node'), { e2e: false })).toBeUndefined();
  });
  it('a plain shell has no adapter', () => {
    expect(adapterFor(def('shell:pwsh', 'pwsh.exe'), { e2e: true })).toBeUndefined();
  });
  it('wiring kinds and notifiability', () => {
    expect(claude.wiring).toBe('mcp-config-flag');
    expect(adapter('fake').wiring).toBe('mcp-config-flag');
    expect(adapter('codex').wiring).toBe('codex-c-flags');
    expect(adapter('cursor').wiring).toBe('cursor-global');
    expect(notifiable(claude)).toBe(true);
    expect(notifiable(adapter('fake'))).toBe(true);
    expect(notifiable(adapter('codex'))).toBe(true);
    expect(notifiable(adapter('cursor'))).toBe(true);
  });
});

// Captured with cell styles: docs/runs/2026-10-26-conduit-mcp/placeholder-cells.md.
describe('screenVerdict ignores placeholder-styled cells', () => {
  const codex = adapter('codex').screen;

  it.each([
    ['claude-suggestion', 'claude', 'empty-input'],
    ['claude-typed', 'claude', 'unknown'],
    ['codex-placeholder', 'codex', 'empty-input'],
    ['codex-typed', 'codex', 'unknown'],
  ] as const)('%s → %s', (name, id, want) => {
    expect(screenVerdict(adapter(id).screen, screen(name))).toBe(want);
  });

  it('the fixtures are what they claim: faint suggestion, typed text not faint', () => {
    const s = screen('claude-suggestion');
    expect(s.lines[s.cursorY]).toMatch(/^❯\syes, go ahead$/);
    expect(s.styles?.[s.cursorY]).toMatch(/^\.\.d+$/);
    const t = screen('codex-typed');
    expect(t.lines[t.cursorY]).toBe('› Summarize recent commits');
    expect(t.styles?.[t.cursorY]).toMatch(/^\.+$/);
  });

  it('a suggestion with no styles in the snapshot is not empty-input', () => {
    const { styles: _, ...s } = screen('claude-suggestion');
    expect(screenVerdict(claude.screen, s)).toBe('unknown');
  });

  it('text placeholders stand in only when the snapshot has no styles', () => {
    const typed = { lines: ['› Summarize recent commits'], cursorY: 0 };
    expect(screenVerdict(codex, typed)).toBe('empty-input');
    expect(screenVerdict(codex, { ...typed, styles: ['.'.repeat(26)] })).toBe('unknown');
    const tryRow = { lines: ['❯ Try "fix lint errors"'], cursorY: 0 };
    expect(screenVerdict(claude.screen, tryRow)).toBe('empty-input');
    expect(screenVerdict(claude.screen, { ...tryRow, styles: [`..${'d'.repeat(21)}`] })).toBe(
      'empty-input',
    );
    expect(screenVerdict(claude.screen, { ...tryRow, styles: ['.'.repeat(23)] })).toBe('unknown');
  });

  it('typed text after a faint run is still input', () => {
    const s = { lines: ['❯ yes, go ahead'], cursorY: 0, styles: ['..dddddddddd...'] };
    expect(screenVerdict(claude.screen, s)).toBe('unknown');
  });

  it('the echo check reads the real text, not the suggestion', () => {
    const s = screen('claude-suggestion');
    const lines = [...s.lines];
    const styles = [...(s.styles ?? [])];
    lines[s.cursorY] = `❯ ${NOTICE}`;
    styles[s.cursorY] = `..${'d'.repeat(NOTICE.length)}`;
    expect(screenVerdict(claude.screen, { lines, cursorY: s.cursorY, styles }, NOTICE)).toBe(
      'empty-input',
    );
    styles[s.cursorY] = '.'.repeat(NOTICE.length + 2);
    expect(screenVerdict(claude.screen, { lines, cursorY: s.cursorY, styles }, NOTICE)).toBe(
      'notice-echoed',
    );
  });

  it('an adapter without a placeholder style keeps faint cells', () => {
    const fake = adapter('fake').screen;
    expect(screenVerdict(fake, { lines: ['fake❯ x'], cursorY: 0, styles: ['......d'] })).toBe(
      'unknown',
    );
  });
});

describe('screenVerdict on the S0 screens', () => {
  it.each([
    ['claude-idle', 'empty-input'],
    ['claude-idle-placeholder', 'empty-input'],
    ['claude-permission', 'blocking'],
    ['claude-trust', 'blocking'],
  ])('%s → %s', (name, want) => {
    expect(screenVerdict(claude.screen, screen(name))).toBe(want);
  });

  it('the permission dialog is found far below the cursor', () => {
    const s = screen('claude-permission');
    expect(s.cursorY).toBe(7);
    const footer = s.lines.findIndex((l) => l.includes('Esc to cancel'));
    expect(footer - s.cursorY).toBeGreaterThan(NOTICE_ECHO_ROWS + 10);
  });

  it('old prompt text above the cursor is not empty-input', () => {
    const s = screen('claude-idle');
    expect(s.lines[5]).toMatch(/^❯\sUse the Bash tool/);
    expect(screenVerdict(claude.screen, { ...s, cursorY: 5 })).toBe('unknown');
  });

  it('a typed notice on the cursor row is notice-echoed', () => {
    const s = screen('claude-idle');
    const lines = [...s.lines];
    lines[13] = `❯ ${NOTICE}`;
    expect(screenVerdict(claude.screen, { lines, cursorY: 13 }, NOTICE)).toBe('notice-echoed');
    expect(screenVerdict(claude.screen, { lines, cursorY: 13 })).toBe('unknown');
  });

  it('a notice wrapped across rows at 40 cols is still notice-echoed', () => {
    const s = screen('claude-idle');
    const typed = `❯ ${NOTICE}`;
    const lines = [...s.lines];
    lines[12] = typed.slice(0, 40);
    lines[13] = typed.slice(40);
    expect(screenVerdict(claude.screen, { lines, cursorY: 13 }, NOTICE)).toBe('notice-echoed');
  });

  it('a notice elsewhere on screen is not an echo', () => {
    const s = screen('claude-idle');
    const lines = [...s.lines];
    lines[5] = `❯ ${NOTICE}`;
    expect(screenVerdict(claude.screen, { lines, cursorY: 13 }, NOTICE)).toBe('empty-input');
  });

  it('a blocking footer anywhere beats an echo', () => {
    const s = screen('claude-idle');
    const lines = [...s.lines];
    lines[13] = `❯ ${NOTICE}`;
    lines[30] = ' Esc to cancel · Tab to amend';
    expect(screenVerdict(claude.screen, { lines, cursorY: 13 }, NOTICE)).toBe('blocking');
  });

  it('codex idle composer is empty-input; typed text and old rows are not', () => {
    const codex = adapter('codex').screen;
    const s = screen('codex-idle');
    expect(screenVerdict(codex, s)).toBe('empty-input');
    expect(screenVerdict(codex, { lines: ['› '], cursorY: 0 })).toBe('empty-input');
    expect(screenVerdict(codex, { lines: ['› Write tests for @filename'], cursorY: 0 })).toBe(
      'empty-input',
    );
    expect(screenVerdict(codex, { lines: ['› fix the build'], cursorY: 0 })).toBe('unknown');
    expect(screenVerdict(codex, { ...s, cursorY: 0 })).toBe('unknown');
    const lines = [...s.lines];
    lines[s.cursorY] = `› ${NOTICE}`;
    expect(screenVerdict(codex, { lines, cursorY: s.cursorY }, NOTICE)).toBe('notice-echoed');
  });

  it('codex approval footer is blocking', () => {
    const s = { lines: ['  Press enter to confirm or esc to cancel'], cursorY: 0 };
    expect(screenVerdict(adapter('codex').screen, s)).toBe('blocking');
  });

  it('codex trust footer is blocking', () => {
    const s = { lines: ['  Trust this folder?', '', '  enter continue · esc quit'], cursorY: 0 };
    expect(screenVerdict(adapter('codex').screen, s)).toBe('blocking');
  });

  it('the fake agent prompt is empty-input', () => {
    const fake = adapter('fake').screen;
    expect(screenVerdict(fake, { lines: ['hello', 'fake❯ '], cursorY: 1 })).toBe('empty-input');
    expect(screenVerdict(fake, { lines: ['Esc to cancel', 'fake❯ '], cursorY: 1 })).toBe(
      'blocking',
    );
  });

  it('null patterns → unknown', () => {
    expect(screenVerdict(null, screen('claude-suggestion'), NOTICE)).toBe('unknown');
    expect(screenVerdict(null, screen('claude-idle'), NOTICE)).toBe('unknown');
  });
});

describe('Cursor screens (S0 captures; input row located by inputRow)', () => {
  const cursor = adapter('cursor');
  it.each([
    ['cursor-idle-startup', 'empty-input'],
    ['cursor-idle-after-turn', 'empty-input'],
    ['cursor-draft', 'unknown'],
    ['cursor-notice-draft', 'unknown'],
    ['cursor-trust', 'blocking'],
    ['cursor-tool-approval', 'blocking'],
    ['cursor-mid-turn', 'unknown'],
    ['cursor-idle-stale-input-row-far-above', 'unknown'],
  ])('%s → %s', (name, want) => {
    expect(screenVerdict(cursor.screen, screen(name))).toBe(want);
  });

  it('the cursor parks below the input row, on a blank row', () => {
    const s = screen('cursor-idle-after-turn');
    const row = s.lines.findLastIndex((l) => /^\s*→/.test(l));
    expect(s.cursorY - row).toBeGreaterThan(NOTICE_ECHO_ROWS);
    expect(s.lines[s.cursorY].trim()).toBe('');
  });

  it('mid-turn: the empty → row is on screen, but the ctrl+c suffix keeps it closed', () => {
    const s = screen('cursor-mid-turn');
    expect(s.lines.some((l) => /^\s*→\s*Add a follow-up/.test(l))).toBe(true);
    expect(screenVerdict(cursor.screen, s)).toBe('unknown');
  });

  it('the notice typed on the input row is echoed although the cursor parks far below', () => {
    expect(screenVerdict(cursor.screen, screen('cursor-notice-draft'), NOTICE)).toBe(
      'notice-echoed',
    );
  });

  it('a notice wrapped downward over the 3 rows from the input row is echoed', () => {
    expect(screenVerdict(cursor.screen, screen('cursor-notice-wrapped-draft'), NOTICE)).toBe(
      'notice-echoed',
    );
  });

  it('a draft that is not the notice is not echoed', () => {
    expect(screenVerdict(cursor.screen, screen('cursor-draft'), NOTICE)).toBe('unknown');
  });
});

describe('a Claude notice wrapped over the 3 rows ending at the cursor', () => {
  it('still reads notice-echoed', () => {
    const s = screen('claude-idle');
    const lines = [...s.lines];
    lines[s.cursorY - 2] = `❯ ${NOTICE.slice(0, 24)}`;
    lines[s.cursorY - 1] = `  ${NOTICE.slice(24, 48)}`;
    lines[s.cursorY] = `  ${NOTICE.slice(48)}`;
    expect(screenVerdict(claude.screen, { lines, cursorY: s.cursorY }, NOTICE)).toBe(
      'notice-echoed',
    );
  });
});
