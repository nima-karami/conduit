import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMachineId } from '../../src/conduit-mcp/machine-id';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-id-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'machine-id.json');

describe('loadMachineId', () => {
  it('machine id is created once and reused', () => {
    const first = loadMachineId(dir);
    expect(loadMachineId(dir)).toBe(first);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1, id: first });
  });

  it('machine id has the m- format', () => {
    expect(loadMachineId(dir)).toMatch(/^m-[0-9a-f]{8}$/);
  });

  it('a bad machine id is replaced', () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 1, id: 'bogus' }));
    const id = loadMachineId(dir);
    expect(id).toMatch(/^m-[0-9a-f]{8}$/);
    expect(id).not.toBe('bogus');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1, id });
  });
});
