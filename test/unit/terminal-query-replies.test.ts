import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeDisplayColor,
  registerTerminalQuerySwallowHandlers,
} from '../../webview/terminal-query-replies';

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

describe('registerTerminalQuerySwallowHandlers', () => {
  it('swallows queries answered by hc while preserving unrelated parser behavior', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    registerTerminalQuerySwallowHandlers(term);
    const replies: string[] = [];
    term.onData((data) => replies.push(data));

    await write(
      term,
      '\x1b[c\x1b[>c\x1b[=c\x1b[5n\x1b[?6n\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07\x1bP$qm\x1b\\',
    );

    expect(replies).toEqual([]);
    term.dispose();
  });

  it('swallows only query OSC payloads and leaves CSI focus reports unregistered', () => {
    const terminal = new Terminal({ allowProposedApi: true });
    const csi = vi.spyOn(terminal.parser, 'registerCsiHandler');
    const osc = vi.spyOn(terminal.parser, 'registerOscHandler');
    const dcs = vi.spyOn(terminal.parser, 'registerDcsHandler');
    registerTerminalQuerySwallowHandlers(terminal);

    expect(csi.mock.calls.map(([id]) => [id.prefix, id.final])).toEqual([
      [undefined, 'c'],
      ['>', 'c'],
      ['=', 'c'],
      [undefined, 'n'],
      ['?', 'n'],
    ]);
    expect(csi.mock.calls.some(([id]) => id.final === 'I' || id.final === 'O')).toBe(false);
    expect(
      osc.mock.calls.map(([ident, handler]) => [ident, handler('?'), handler('#112233')]),
    ).toEqual([
      [10, true, false],
      [11, true, false],
      [12, true, false],
    ]);
    expect(
      dcs.mock.calls.map(([id, handler]) => [id.intermediates, id.final, handler('', [])]),
    ).toEqual([['$', 'q', true]]);
    terminal.dispose();
  });
});

describe('normalizeDisplayColor', () => {
  it('composites alpha against the supplied surface and emits an opaque hex color', () => {
    expect(normalizeDisplayColor('rgba(255, 0, 0, 0.5)', '#0000ff')).toBe('#800080');
    expect(normalizeDisplayColor('rgb(255 0 0 / 50%)', '#0000ff')).toBe('#800080');
    expect(normalizeDisplayColor('rgb(100% 0% 0% / 50%)', '#0000ff')).toBe('#800080');
  });

  it('keeps opaque colors and uses the surface for fully transparent colors', () => {
    expect(normalizeDisplayColor('rgb(12, 34, 56)', '#ffffff')).toBe('#0c2238');
    expect(normalizeDisplayColor('rgba(255, 255, 255, 0)', '#123456')).toBe('#123456');
  });
});
