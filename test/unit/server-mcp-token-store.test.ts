import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersistentTokenStore } from '../../server/mcp/token-file';
import type { TokenRows } from '../../src/contracts/server-ports';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-tokens-'));
  dirs.push(dir);
  return path.join(dir, 'conduit-mcp', 'tokens.json');
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const ids = (generation: number, launchId = `${generation}`.padStart(32, 'a')) => ({
  generation,
  launchId,
});

function tokenSource() {
  let n = 0;
  return () => `tok-${++n}`;
}

const loaded = (r: TokenRows) => {
  if (r.state !== 'loaded') throw new Error(`store is ${r.state}`);
  return r.rows;
};

describe('persistent TokenStorePort', () => {
  it('persists only the hash of a reserved token, before any run', async () => {
    const file = tmpFile();
    const store = createPersistentTokenStore({ file, randomToken: tokenSource() });
    const { token } = await store.reserve('s1', ids(1));
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    const disk = JSON.parse(text);
    expect(disk.version).toBe(1);
    expect(disk.rows).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        sha256: sha(token),
        state: 'reserved',
        hcAddress: null,
        generation: 1,
      }),
    ]);
  });

  it('walks the D21 row states and survives a reload', async () => {
    const file = tmpFile();
    const store = createPersistentTokenStore({ file, randomToken: tokenSource() });
    await store.reserve('s1', ids(1));
    await store.resolveAddress(ids(1).launchId, 'hc:1');
    expect(loaded(store.rows())[0]).toMatchObject({ state: 'live', hcAddress: 'hc:1' });

    // A new launch of a live session revokes the old row.
    await store.reserve('s1', ids(2));
    await store.markUnconfirmed(ids(2).launchId);
    expect(loaded(store.rows()).map((r) => [r.generation, r.state])).toEqual([[2, 'unconfirmed']]);

    // A new launch over an unconfirmed one supersedes it instead.
    await store.reserve('s1', ids(3));
    expect(loaded(store.rows()).map((r) => [r.generation, r.state])).toEqual([
      [2, 'superseded'],
      [3, 'reserved'],
    ]);

    const again = createPersistentTokenStore({ file, randomToken: tokenSource() });
    expect(loaded(again.rows()).map((r) => [r.generation, r.state])).toEqual([
      [2, 'superseded'],
      [3, 'reserved'],
    ]);
  });

  it('markUnconfirmed only moves a reserved row', async () => {
    const store = createPersistentTokenStore({ file: tmpFile(), randomToken: tokenSource() });
    await store.reserve('s1', ids(1));
    await store.resolveAddress(ids(1).launchId, 'hc:1');
    await store.markUnconfirmed(ids(1).launchId);
    expect(loaded(store.rows())[0]?.state).toBe('live');
  });

  it('markSuperseded marks the launch, and a late address does not revive it', async () => {
    const file = tmpFile();
    const store = createPersistentTokenStore({ file, randomToken: tokenSource() });
    await store.reserve('s1', ids(1));
    await store.markSuperseded(ids(1).launchId);
    await store.resolveAddress(ids(1).launchId, 'hc:late');
    expect(loaded(store.rows())[0]).toMatchObject({ state: 'superseded', hcAddress: 'hc:late' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).rows[0].state).toBe('superseded');
  });

  it('revoke by session removes every row of it; by launch id only that row', async () => {
    const file = tmpFile();
    const store = createPersistentTokenStore({ file, randomToken: tokenSource() });
    await store.reserve('s1', ids(1));
    await store.markUnconfirmed(ids(1).launchId);
    await store.reserve('s1', ids(2));
    await store.reserve('s2', ids(7));
    await store.revoke({ launchId: ids(7).launchId });
    expect(loaded(store.rows()).map((r) => r.sessionId)).toEqual(['s1', 's1']);
    await store.revoke({ sessionId: 's1' });
    expect(loaded(store.rows())).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).rows).toEqual([]);
  });

  it('a missing file is `missing` until the first write', async () => {
    const store = createPersistentTokenStore({ file: tmpFile(), randomToken: tokenSource() });
    expect(store.rows()).toEqual({ state: 'missing' });
    await store.reserve('s1', ids(1));
    expect(store.rows().state).toBe('loaded');
  });

  it('an unreadable file stays unreadable and is never overwritten', async () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":1,"rows":[{"sessionId":');
    const store = createPersistentTokenStore({ file, randomToken: tokenSource() });
    expect(store.rows()).toEqual({ state: 'unreadable' });
    await expect(store.reserve('s1', ids(1))).rejects.toThrow('token store unreadable');
    await store.revoke({ sessionId: 's1' });
    expect(store.rows()).toEqual({ state: 'unreadable' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":1,"rows":[{"sessionId":');
  });

  it('a newer file is refused for the run and never overwritten', async () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const newer = JSON.stringify({ version: 2, rows: [], extra: true });
    fs.writeFileSync(file, newer);
    const store = createPersistentTokenStore({ file, randomToken: tokenSource() });
    expect(store.rows()).toEqual({ state: 'unreadable' });
    await expect(store.reserve('s1', ids(1))).rejects.toThrow('token store unreadable');
    await store.markSuperseded(ids(1).launchId);
    expect(fs.readFileSync(file, 'utf8')).toBe(newer);
  });

  it('a failed write rejects the reservation and keeps no row', async () => {
    const file = tmpFile();
    const store = createPersistentTokenStore({
      file,
      randomToken: tokenSource(),
      write: () => {
        throw new Error('EACCES');
      },
    });
    await expect(store.reserve('s1', ids(1))).rejects.toThrow('EACCES');
    expect(store.rows()).toEqual({ state: 'missing' });
  });
});
