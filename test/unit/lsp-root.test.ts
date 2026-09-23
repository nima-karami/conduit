import { describe, expect, it } from 'vitest';
import { GO_SERVER } from '../../src/lsp-registry';
import {
  isEscapedRoot,
  isWithin,
  type RootProbe,
  resolveServerRoot,
  type ServerRoot,
  serverKeyFor,
  toLexicalPath,
} from '../../src/lsp-root';

/** resolveServerRoot for cases that must not escape — narrows the result for the assertions. */
async function rootOf(...args: Parameters<typeof resolveServerRoot>): Promise<ServerRoot | null> {
  const r = await resolveServerRoot(...args);
  if (isEscapedRoot(r)) throw new Error('unexpected escape');
  return r;
}

function probe(files: string[], real: Record<string, string> = {}): RootProbe {
  const set = new Set(files);
  return { exists: async (p) => set.has(p), realpath: async (p) => real[p] ?? p };
}

describe('resolveServerRoot', () => {
  it('nearest go.mod wins', async () => {
    const r = await rootOf(
      'C:\\w\\a\\b\\main.go',
      ['C:\\w'],
      GO_SERVER,
      probe(['C:\\w\\go.mod', 'C:\\w\\a\\go.mod']),
      'win32',
    );
    expect(r).toEqual({
      key: 'go:C:\\w\\a',
      realRoot: 'C:\\w\\a',
      root: 'C:\\w\\a',
      workspaceRoot: 'C:\\w',
      adHoc: false,
    });
  });

  it('highest go.work wins over a nearer go.mod', async () => {
    const r = await rootOf(
      '/w/x/a/b/main.go',
      ['/w'],
      GO_SERVER,
      probe(['/w/go.work', '/w/x/go.work', '/w/x/a/go.mod']),
      'linux',
    );
    expect(r?.root).toBe('/w');
    expect(r?.adHoc).toBe(false);
  });

  it('no marker → workspace root, adHoc', async () => {
    const r = await rootOf('c:/w/a/main.go', ['C:\\W'], GO_SERVER, probe([]), 'win32');
    expect(r).toMatchObject({
      root: 'C:\\w',
      workspaceRoot: 'C:\\W',
      adHoc: true,
      key: 'go:C:\\w',
    });
  });

  it('does not look above the workspace root', async () => {
    const r = await rootOf('/w/a/main.go', ['/w'], GO_SERVER, probe(['/go.mod']), 'linux');
    expect(r?.adHoc).toBe(true);
    expect(r?.root).toBe('/w');
  });

  it('deepest workspace root is used', async () => {
    const r = await rootOf('/w/in/a.go', ['/w', '/w/in'], GO_SERVER, probe([]), 'linux');
    expect(r?.workspaceRoot).toBe('/w/in');
    expect(r?.root).toBe('/w/in');
  });

  it('outside every root → null', async () => {
    expect(
      await resolveServerRoot('/goroot/src/fmt/print.go', ['/w'], GO_SERVER, probe([]), 'linux'),
    ).toBeNull();
    expect(await resolveServerRoot('/wx/a.go', ['/w'], GO_SERVER, probe([]), 'linux')).toBeNull();
  });

  it('key uses realRoot; root keeps the lexical spelling', async () => {
    const r = await rootOf(
      'S:\\m\\main.go',
      ['S:\\'],
      GO_SERVER,
      // `S:` is a subst of G:\real, so the workspace resolves there too.
      probe(['S:\\m\\go.mod'], { 'S:\\': 'G:\\real', 'S:\\m': 'G:\\real\\m' }),
      'win32',
    );
    expect(r?.key).toBe('go:G:\\real\\m');
    expect(r?.key).toBe(serverKeyFor('go', 'G:\\real\\m'));
    expect(r?.root).toBe('S:\\m');
    expect(r?.realRoot).toBe('G:\\real\\m');
  });
});

describe('isWithin', () => {
  it('win32 containment is case-insensitive; linux is case-sensitive', () => {
    expect(isWithin('g:\\P\\x', 'G:\\p', 'win32')).toBe(true);
    expect(isWithin('G:/p/x', 'G:\\p\\', 'win32')).toBe(true);
    expect(isWithin('G:\\px', 'G:\\p', 'win32')).toBe(false);
    expect(isWithin('/P/x', '/p', 'linux')).toBe(false);
    expect(isWithin('/p/x', '/p', 'linux')).toBe(true);
    expect(isWithin('G:\\x', 'G:\\', 'win32')).toBe(true);
  });
});

describe('toLexicalPath', () => {
  it('maps realRoot-prefixed paths onto the lexical root and leaves others alone', () => {
    expect(toLexicalPath('G:\\real\\m\\a.go', 'G:\\real\\m', 'S:\\m', 'win32')).toBe('S:\\m\\a.go');
    expect(toLexicalPath('g:/REAL/m/pkg/b.go', 'G:\\real\\m', 'S:\\m', 'win32')).toBe(
      'S:\\m\\pkg\\b.go',
    );
    expect(toLexicalPath('C:\\goroot\\x.go', 'G:\\real\\m', 'S:\\m', 'win32')).toBe(
      'C:\\goroot\\x.go',
    );
    expect(toLexicalPath('/real/m/a.go', '/real/m', '/link/m', 'linux')).toBe('/link/m/a.go');
    expect(toLexicalPath('/real/m/a.go', '/real/m', '/real/m', 'linux')).toBe('/real/m/a.go');
  });
});

describe('realpath confinement (review #1)', () => {
  it('a root whose realpath leaves the workspace is refused (symlink escape)', async () => {
    const r = await resolveServerRoot(
      '/w/link/main.go',
      ['/w'],
      GO_SERVER,
      probe(['/w/link/go.mod'], { '/w/link': '/elsewhere/mod' }),
      'linux',
    );
    expect(r).toEqual({ escapesWorkspace: true });
  });

  it('win32: a junctioned root outside the real workspace is refused', async () => {
    const r = await resolveServerRoot(
      'G:\\ws\\j\\main.go',
      ['G:\\ws'],
      GO_SERVER,
      probe(['G:\\ws\\j\\go.mod'], { 'G:\\ws\\j': 'D:\\other' }),
      'win32',
    );
    expect(r).toEqual({ escapesWorkspace: true });
  });

  it('a workspace that is itself a link is judged by both realpaths', async () => {
    const r = await rootOf(
      'S:\\m\\main.go',
      ['S:\\'],
      GO_SERVER,
      probe(['S:\\m\\go.mod'], { 'S:\\': 'G:\\real\\', 'S:\\m': 'G:\\real\\m' }),
      'win32',
    );
    expect(r?.realRoot).toBe('G:\\real\\m');
  });

  it('a lexically escaping path never resolves, whatever the probe says', async () => {
    for (const [file, ws, platform] of [
      ['G:\\ws\\..\\..\\other\\x.go', 'G:\\ws', 'win32'],
      ['/w/ws/../../etc/x.go', '/w/ws', 'linux'],
    ] as const) {
      expect(await resolveServerRoot(file, [ws], GO_SERVER, probe([]), platform), file).toBeNull();
    }
  });
});
