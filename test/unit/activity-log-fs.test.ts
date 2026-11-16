import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActivityIo } from '../../src/conduit-mcp/activity-log-fs';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('activity io', () => {
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
