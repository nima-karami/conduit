import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBindingStore } from '../../server/mcp/bindings-file';
import type { CliBindingRecord } from '../../src/contracts/session-identity';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmpFile = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-bindings-'));
  dirs.push(d);
  return path.join(d, 'bindings.json');
};
const rec = (sessionId: string, generation = 1): CliBindingRecord => ({
  sessionId,
  generation,
  cli: 'codex',
  clientInfoName: 'codex-mcp-client',
});

describe('bindings.json (D28)', () => {
  it('persists a binding, survives a reload, and deletes it', () => {
    const file = tmpFile();
    const a = createBindingStore({ file });
    a.set(rec('s1'));
    a.set(rec('s2', 3));
    a.set(rec('s1', 2));
    const b = createBindingStore({ file });
    expect(b.get('s1')).toEqual(rec('s1', 2));
    expect(b.get('s2')).toEqual(rec('s2', 3));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
    b.delete('s1');
    expect(createBindingStore({ file }).get('s1')).toBeUndefined();
  });

  it('a newer file is refused for the run and never overwritten', () => {
    const file = tmpFile();
    const newer = JSON.stringify({ version: 9, bindings: [rec('s1')] });
    fs.writeFileSync(file, newer);
    const store = createBindingStore({ file });
    expect(store.get('s1')).toBeUndefined();
    store.set(rec('s2'));
    store.delete('s1');
    expect(fs.readFileSync(file, 'utf8')).toBe(newer);
  });
});
