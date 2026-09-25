import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileState } from '../../src/config';

describe('readFileState', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-file-state-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('missing file → absent', () => {
    expect(readFileState(path.join(dir, 'nope.json'))).toEqual({ kind: 'absent' });
  });

  it('a directory path → unreadable with its code', () => {
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    expect(readFileState(sub)).toEqual({ kind: 'unreadable', code: 'EISDIR' });
  });

  it('file → text', () => {
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, '{"a":1}');
    expect(readFileState(file)).toEqual({ kind: 'text', text: '{"a":1}' });
  });
});
