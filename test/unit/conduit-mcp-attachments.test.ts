import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AttachmentFs,
  MAX_ATTACHMENT_BYTES,
  mimeFor,
  nodeAttachmentFs,
  snapshotAttachment,
  TEXT_PAGE_BYTES,
  textPage,
} from '../../src/conduit-mcp/attachments';

let base: string;
let home: string;
let other: string;
let outside: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-mcp-att-'));
  home = path.join(base, 'home');
  other = path.join(base, 'other-root');
  outside = path.join(base, 'outside');
  for (const d of [home, other, outside, path.join(home, 'docs')]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(home, 'docs', 'spec.md'), '# spec\n');
  fs.writeFileSync(path.join(other, 'notes.txt'), 'other root');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(home, 'escape'), 'junction');
  fs.symlinkSync(path.join(home, 'docs'), path.join(home, 'inside-link'), 'junction');
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const sender = () => ({ home, roots: [other] });
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const code = (r: Awaited<ReturnType<typeof snapshotAttachment>>) => (r.ok ? 'ok' : r.error.code);

function spyFs(over: Partial<AttachmentFs> = {}) {
  const seen: Array<[string, string]> = [];
  const f: AttachmentFs = {
    stat: async (p) => {
      seen.push(['stat', p]);
      return over.stat ? over.stat(p) : nodeAttachmentFs.stat(p);
    },
    readFile: async (p) => {
      seen.push(['readFile', p]);
      return over.readFile ? over.readFile(p) : nodeAttachmentFs.readFile(p);
    },
  };
  return { f, seen };
}

describe('snapshotAttachment', () => {
  it('relative path resolves against home', async () => {
    const r = await snapshotAttachment(sender(), 'docs/spec.md');
    expect(r.ok && r.value).toMatchObject({ name: 'spec.md', sha256: sha('# spec\n') });
    expect(r.ok && Buffer.from(r.value.data).toString()).toBe('# spec\n');
  });

  it('an absolute path in another of the sender roots is allowed', async () => {
    const r = await snapshotAttachment(sender(), path.join(other, 'notes.txt'));
    expect(r.ok && r.value.mime).toBe('text/plain');
  });

  it('../ escaping the roots → path_outside_roots', async () => {
    expect(code(await snapshotAttachment(sender(), '../outside/secret.txt'))).toBe(
      'path_outside_roots',
    );
    expect(code(await snapshotAttachment(sender(), '../../.ssh/id_rsa'))).toBe(
      'path_outside_roots',
    );
  });

  it('a link inside a root pointing outside → path_outside_roots', async () => {
    const { f, seen } = spyFs();
    expect(code(await snapshotAttachment(sender(), 'escape/secret.txt', f))).toBe(
      'path_outside_roots',
    );
    expect(seen).toEqual([]);
  });

  it('a missing file → path_unreadable', async () => {
    expect(code(await snapshotAttachment(sender(), 'docs/nope.md'))).toBe('path_unreadable');
  });

  it('a directory → path_unreadable', async () => {
    expect(code(await snapshotAttachment(sender(), 'docs'))).toBe('path_unreadable');
  });

  it('10 MB + 1 → too_large (by stat, before reading)', async () => {
    const { f, seen } = spyFs({
      stat: async () => ({ size: MAX_ATTACHMENT_BYTES + 1, isFile: true }),
    });
    expect(code(await snapshotAttachment(sender(), 'docs/spec.md', f))).toBe('too_large');
    expect(seen.map(([op]) => op)).toEqual(['stat']);
  });

  it('a file that grew past the limit after stat → too_large', async () => {
    const { f } = spyFs({ readFile: async () => new Uint8Array(MAX_ATTACHMENT_BYTES + 1) });
    expect(code(await snapshotAttachment(sender(), 'docs/spec.md', f))).toBe('too_large');
  });

  it('a read error → path_unreadable', async () => {
    const { f } = spyFs({
      readFile: async () => {
        throw new Error('EACCES');
      },
    });
    expect(code(await snapshotAttachment(sender(), 'docs/spec.md', f))).toBe('path_unreadable');
  });

  it('a link from one root into another root is refused (same-root rule)', async () => {
    fs.symlinkSync(other, path.join(home, 'cross-link'), 'junction');
    expect(code(await snapshotAttachment(sender(), 'cross-link/notes.txt'))).toBe(
      'path_outside_roots',
    );
  });

  it('reads from the realpath that was checked', async () => {
    const { f, seen } = spyFs();
    const r = await snapshotAttachment(sender(), 'inside-link/spec.md', f);
    expect(r.ok).toBe(true);
    const real = fs.realpathSync.native(path.join(home, 'docs', 'spec.md'));
    expect(seen).toEqual([
      ['stat', real],
      ['readFile', real],
    ]);
  });
});

describe('mimeFor', () => {
  const text = new TextEncoder().encode('hello\n');
  it('images by extension', () => {
    expect(mimeFor('a.png', new Uint8Array([0]))).toBe('image/png');
    expect(mimeFor('A.JPG', new Uint8Array([0]))).toBe('image/jpeg');
  });
  it('known text extensions', () => {
    expect(mimeFor('spec.md', text)).toBe('text/markdown');
    expect(mimeFor('x.ts', text)).toBe('text/plain');
  });
  it('utf-8 text without an extension → text/plain', () => {
    expect(mimeFor('README', text)).toBe('text/plain');
  });
  it('bytes with NUL → application/octet-stream', () => {
    expect(mimeFor('blob', new Uint8Array([104, 0, 105]))).toBe('application/octet-stream');
    expect(mimeFor('a.zip', new Uint8Array([0x50, 0x4b, 3, 4, 0]))).toBe(
      'application/octet-stream',
    );
  });
  it('invalid utf-8 → application/octet-stream', () => {
    expect(mimeFor('blob', new Uint8Array([0xff, 0xfe, 0x41]))).toBe('application/octet-stream');
  });
});

describe('textPage', () => {
  it('splits a 3-byte char on the 64 KB boundary without breaking it', () => {
    const data = new TextEncoder().encode(`${'a'.repeat(TEXT_PAGE_BYTES - 1)}€b`);
    const first = textPage(data, 0);
    expect(first.nextOffset).toBe(TEXT_PAGE_BYTES - 1);
    expect(first.text).toBe('a'.repeat(TEXT_PAGE_BYTES - 1));
    const second = textPage(data, first.nextOffset ?? -1);
    expect(second).toEqual({ text: '€b', nextOffset: null });
  });
  it('bytes with no character boundary still page forward', () => {
    const data = new Uint8Array(70 * 1024).fill(0x80);
    const first = textPage(data, 0);
    expect(first.nextOffset).toBe(TEXT_PAGE_BYTES);
    const offsets: number[] = [];
    let at: number | null = 0;
    while (at !== null && offsets.length < 10) {
      offsets.push(at);
      const next: number | null = textPage(data, at).nextOffset;
      if (next !== null) expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(offsets).toEqual([0, TEXT_PAGE_BYTES]);
  });
  it('a short file is one page', () => {
    expect(textPage(new TextEncoder().encode('hi'), 0)).toEqual({ text: 'hi', nextOffset: null });
  });
  it('an offset at or past the end is an empty last page', () => {
    expect(textPage(new TextEncoder().encode('hi'), 5)).toEqual({ text: '', nextOffset: null });
  });
});
