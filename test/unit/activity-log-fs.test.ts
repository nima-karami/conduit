import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivityIo } from '../../src/conduit-mcp/activity-log-fs';

vi.mock('node:fs', async () => {
  const original = await vi.importActual<typeof fs>('node:fs');
  return { ...original, fstatSync: vi.fn(original.fstatSync) };
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('activity io', () => {
  it('reads only valid ISO day paths within an explicit byte budget', () => {
    const io = createActivityIo(dir);
    expect(io).toHaveProperty('read');
    io.append('2026-11-17', 'hello');
    expect(io.read('2026-11-17', 5)).toBe('hello');
    expect(() => io.read('2026-11-17', 4)).toThrow(/budget/);
    expect(() => io.read('../ask-args', 20)).toThrow(/day/);
    expect(() => io.read('2026-02-30', 20)).toThrow(/day/);
    expect(() => io.read('2026-11-17', -1)).toThrow(/budget/);
    expect(() => io.read('2026-11-16', 20)).toThrow();
  });

  it('caps actual reads when a day has grown beyond its stat size', () => {
    const io = createActivityIo(dir);
    io.append('2026-11-17', 'hello');
    const stat = fs.statSync(path.join(dir, 'activity', '2026-11-17.jsonl'));
    stat.size = 1;
    vi.mocked(fs.fstatSync).mockReturnValueOnce(stat);
    expect(() => io.read('2026-11-17', 4)).toThrow(/budget/);
  });

  it('activity io appends, lists and removes day files', () => {
    const io = createActivityIo(dir);
    expect(io.list()).toEqual([]);
    expect(io.readArgs()).toBeNull();

    io.append('2026-11-13', 'one\n');
    io.append('2026-11-14', 'two\n');
    io.append('2026-11-14', 'more\n');
    expect(io.list().sort((a, b) => a.day.localeCompare(b.day))).toEqual([
      { day: '2026-11-13', bytes: 4 },
      { day: '2026-11-14', bytes: 9 },
    ]);
    expect(fs.readFileSync(path.join(dir, 'activity', '2026-11-14.jsonl'), 'utf8')).toBe(
      'two\nmore\n',
    );

    io.writeArgs('{"r1":{"at":1,"args":{}}}');
    expect(io.readArgs()).toBe('{"r1":{"at":1,"args":{}}}');
    expect(io.list()).toHaveLength(2);

    io.remove('2026-11-13');
    expect(io.list()).toEqual([{ day: '2026-11-14', bytes: 9 }]);
  });
});
