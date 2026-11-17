import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPolicyIo, POLICY_MAX_BYTES } from '../../src/conduit-mcp/policy-file-fs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const location = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'con25-policy-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'policy.json');
};

describe('policy file IO', () => {
  it('atomically replaces complete files and returns only after writing', () => {
    const file = location();
    const io = createPolicyIo(file);
    expect(io.read()).toBeNull();
    expect(io.writeSync('{"one":1}')).toBe(true);
    expect(io.read()).toBe('{"one":1}');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['policy.json']);
    expect(io.writeSync('{"two":2}')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"two":2}');
  });
  it('rejects oversized encoded candidates without replacing the saved file', () => {
    const file = location();
    const io = createPolicyIo(file);
    io.writeSync('old');
    expect(() => io.writeSync('é'.repeat(POLICY_MAX_BYTES))).toThrow(/large/);
    expect(io.read()).toBe('old');
  });
  it('propagates write errors rather than returning a success', () => {
    const file = location();
    fs.mkdirSync(file, { recursive: true });
    expect(() => createPolicyIo(file).writeSync('new')).toThrow();
  });
});
