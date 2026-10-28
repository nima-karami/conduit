import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_ADAPTERS } from '../../src/conduit-mcp/adapters';
import {
  type InputBoxOpts,
  inPromptEcho,
  inputBoxPrompt,
  inputBoxTop,
  type RowView,
} from '../../src/input-box-rows';

const SCREENS = path.join(__dirname, 'fixtures', 'conduit-mcp', 'screens');
interface Fixture {
  lines: string[];
  cursorY: number;
  cols?: number;
}
const fixture = (name: string): Fixture =>
  JSON.parse(fs.readFileSync(path.join(SCREENS, `${name}.json`), 'utf8')) as Fixture;

const screenOf = (id: string) => {
  const a = MCP_ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(id);
  return a.screen;
};

/** The fixture as a buffer whose viewport starts at row `base` (rows above it are scrollback). */
function topOf(f: Fixture, prompt?: InputBoxOpts['prompt'], base = 0): number | null {
  const rows = f.lines.length;
  const cols = f.cols ?? Math.max(...f.lines.map((l) => l.length));
  return inputBoxTop((y) => (y >= base ? f.lines[y - base] : 'scrollback'), base + f.cursorY, {
    cols,
    rows,
    prompt,
  });
}

const RULE = '─'.repeat(40);
const synth = (lines: string[], cursorY: number): Fixture => ({ lines, cursorY, cols: 40 });

describe('inputBoxTop — Claude ruled box (no identity)', () => {
  it.each([
    ['claude-typed', 26],
    ['claude-idle-placeholder', 5],
    ['claude-suggestion', 26],
  ])('%s → the top rule (row %i)', (name, want) => {
    expect(topOf(fixture(name))).toBe(want);
  });

  it('is in buffer rows, so scrollback above the viewport shifts it', () => {
    expect(topOf(fixture('claude-typed'), undefined, 500)).toBe(526);
  });

  it.each(['claude-permission', 'claude-trust'])(
    '%s (a dialog replaced the box) → null',
    (name) => {
      expect(topOf(fixture(name))).toBeNull();
    },
  );

  it('wrapped multi-line input: the cursor on a lower input row still finds the top rule', () => {
    const f = synth(['● out', '', RULE, '❯ one', '  two', '  three', RULE, '  status'], 5);
    expect(topOf(f)).toBe(2);
  });

  it('the nearest rule above the cursor is the box, not a rule in output above it', () => {
    const f = synth([RULE, '● out', RULE, '❯ hi', RULE], 3);
    expect(topOf(f)).toBe(2);
  });

  it('a rule with an embedded label still counts', () => {
    const label = `${'─'.repeat(30)} bash ${'─'.repeat(4)}`;
    expect(topOf(synth([label, '! ls', RULE], 1))).toBe(0);
  });

  it('a short rule (under half the width) does not', () => {
    expect(topOf(synth(['─────', '❯ hi', RULE], 1))).toBeNull();
  });

  it('the cursor left the box (below the bottom rule) → null: its rows are history', () => {
    expect(topOf(synth([RULE, '❯ hi', RULE, '$ next'], 3))).toBeNull();
  });

  it('a TUI drawing rules around the cursor without a ❯ row under the top → null', () => {
    expect(topOf(synth([RULE, '│ file.ts', '│ other.ts', RULE], 1))).toBeNull();
  });

  it('a top rule further than one viewport above the cursor → null (fails open)', () => {
    const lines = [RULE, '❯ a', ...Array.from({ length: 10 }, () => '  more'), RULE];
    const f = synth(lines, 11);
    expect(inputBoxTop((y) => f.lines[y], 11, { cols: 40, rows: 6 })).toBeNull();
  });
});

describe('inputBoxTop — adapter prompt rows', () => {
  const codex = inputBoxPrompt(screenOf('codex'));
  const cursor = inputBoxPrompt(screenOf('cursor'));

  it('codex and cursor have a prompt shape; claude needs none', () => {
    expect(codex).toBeDefined();
    expect(cursor).toBeDefined();
    expect(inputBoxPrompt(screenOf('claude'))).toBeUndefined();
    expect(inputBoxPrompt(null)).toBeUndefined();
  });

  it.each([
    ['codex-typed', 32],
    ['codex-placeholder', 32],
    ['codex-idle', 40],
  ])('%s → the › row (%i)', (name, want) => {
    expect(topOf(fixture(name), codex)).toBe(want);
  });

  it.each([
    ['cursor-draft', 31],
    ['cursor-idle-after-turn', 51],
    ['cursor-mid-turn', 42],
  ])('%s → the → row (%i)', (name, want) => {
    expect(topOf(fixture(name), cursor)).toBe(want);
  });

  it.each(['cursor-idle-stale-input-row-far-above', 'cursor-tool-approval'])(
    '%s (stale row / approval dialog) → null',
    (name) => {
      expect(topOf(fixture(name), cursor)).toBeNull();
    },
  );

  it('codex multi-line draft: cursor below the › row', () => {
    expect(topOf(synth(['• out', '› one', '  two', '  three'], 3), codex)).toBe(1);
  });

  it('without the adapter a › or → row is ordinary text', () => {
    expect(topOf(fixture('codex-typed'))).toBeNull();
    expect(topOf(fixture('cursor-draft'))).toBeNull();
  });
});

// Real captures with cell styles (fixtures/input-box-links/*.json, see their `source`).
interface StyledFixture {
  lines: string[];
  col0: { bg: string; dim: boolean }[];
}
const styled = (name: string): StyledFixture =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'input-box-links', `${name}.json`), 'utf8'),
  ) as StyledFixture;
const viewOf =
  (f: StyledFixture) =>
  (y: number): RowView | undefined =>
    y < f.lines.length ? { text: f.lines[y], bg0: f.col0[y].bg, dim0: f.col0[y].dim } : undefined;
/** The last row containing `needle`: agent output comes after the prompt that quoted it. */
const rowWith = (f: StyledFixture, needle: string) =>
  f.lines.findLastIndex((l) => l.includes(needle));
const echoRows = (f: StyledFixture, echo?: RegExp) =>
  f.lines.flatMap((_, y) => (inPromptEcho(viewOf(f), y, echo) ? [y] : []));

describe('inPromptEcho — submitted prompts echoed into history', () => {
  it('Claude: the ❯ row on a background and its wrapped rows, nothing else', () => {
    const f = styled('claude-echo-draft');
    const start = rowWith(f, 'Reply with');
    expect(echoRows(f)).toEqual([start, start + 1, start + 2]);
    expect(f.lines[start + 2]).toContain('echoed-prompt-link');
  });

  it('Claude: the live box row (❯ with no background) and agent output are not echoes', () => {
    const f = styled('claude-echo-draft');
    expect(inPromptEcho(viewOf(f), rowWith(f, 'second draft'))).toBe(false);
    expect(inPromptEcho(viewOf(f), rowWith(f, 'plain-link'))).toBe(false);
  });

  it('a ❯ row with no background (plain text, a starship prompt) is not an echo', () => {
    const rows: RowView[] = [{ text: '❯ git clone https://x.test/r', bg0: '', dim0: false }];
    expect(inPromptEcho((y) => rows[y], 0)).toBe(false);
  });

  it('background rows with no ❯ row above them (a code block) are not an echo', () => {
    const rows: RowView[] = [
      { text: '● Here:', bg0: '', dim0: false },
      { text: '  https://x.test/a', bg0: '2:236', dim0: false },
      { text: '  https://x.test/b', bg0: '2:236', dim0: false },
    ];
    expect([1, 2].map((y) => inPromptEcho((r) => rows[r], y))).toEqual([false, false]);
  });

  it('a background row below an earlier echo, past agent output, is not part of that echo', () => {
    const rows: RowView[] = [
      { text: '❯ fix it', bg0: '3:3618615', dim0: false },
      { text: '● Done, see:', bg0: '', dim0: false },
      { text: '  https://x.test/a', bg0: '3:3618615', dim0: false },
    ];
    expect(inPromptEcho((r) => rows[r], 2)).toBe(false);
  });

  it('Codex (by adapter): the dim › row and its indented rows, not `• > quote` output', () => {
    const f = styled('codex-echo-draft');
    const echo = inputBoxPrompt(screenOf('codex'))?.echo;
    expect(echo).toBeDefined();
    const start = rowWith(f, 'Reply with');
    expect(echoRows(f, echo)).toEqual([start, start + 1, start + 2]);
    expect(inPromptEcho(viewOf(f), rowWith(f, '> Plain'), echo)).toBe(false);
    expect(inPromptEcho(viewOf(f), rowWith(f, 'second draft'), echo)).toBe(false);
  });

  it('Codex rows are ordinary text without the adapter', () => {
    expect(echoRows(styled('codex-echo-draft'))).toEqual([]);
  });

  it('cursor has no echo shape (no reliable signal measured)', () => {
    expect(inputBoxPrompt(screenOf('cursor'))?.echo).toBeUndefined();
  });
});
