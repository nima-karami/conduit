import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureHookClient, type HookClientFs } from '../../server/mcp/hook-client-file';

function memFs(files: Record<string, string>) {
  const store = new Map<string, Buffer>(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  const writes: string[] = [];
  const fs: HookClientFs = {
    read: (p) => store.get(p) ?? null,
    exists: (p) => store.has(p),
    writeAtomic: (p, d) => {
      writes.push(p);
      store.set(p, d);
    },
    mkdir: () => {},
  };
  return { fs, store, writes };
}

const SRC = path.join('/res', 'conduit-mcp');
const DST = path.join('/data', 'conduit-mcp', 'hooks');

describe('ensureHookClient', () => {
  it('copies the client once under a content-addressed name and reuses it after', () => {
    const m = memFs({ [path.join(SRC, 'conduit-hook.cjs')]: 'v1' });
    const warn = () => {};
    const a = ensureHookClient({ sourceDir: SRC, targetDir: DST, fs: m.fs, warn });
    const b = ensureHookClient({ sourceDir: SRC, targetDir: DST, fs: m.fs, warn });
    expect(a).toMatch(/conduit-hook-[0-9a-f]{16}\.cjs$/);
    expect(b).toBe(a);
    expect(m.writes).toEqual([a]);
  });

  it('a new client version lands beside the old one, which stays for agents launched with it', () => {
    const m = memFs({ [path.join(SRC, 'conduit-hook.cjs')]: 'v1' });
    const warn = () => {};
    const a = ensureHookClient({ sourceDir: SRC, targetDir: DST, fs: m.fs, warn });
    m.store.set(path.join(SRC, 'conduit-hook.cjs'), Buffer.from('v2'));
    const b = ensureHookClient({ sourceDir: SRC, targetDir: DST, fs: m.fs, warn });
    expect(b).not.toBe(a);
    expect(a && m.store.has(a)).toBe(true);
  });

  it('a missing source means no hooks, with one warning', () => {
    const warnings: string[] = [];
    const r = ensureHookClient({
      sourceDir: SRC,
      targetDir: DST,
      fs: memFs({}).fs,
      warn: (msg) => warnings.push(msg),
    });
    expect(r).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});
