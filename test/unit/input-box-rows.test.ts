import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_ADAPTERS } from '../../src/conduit-mcp/adapters';
import { type InputBoxOpts, inputBoxPrompt, inputBoxTop } from '../../src/input-box-rows';

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
