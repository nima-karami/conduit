import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPolicyIo, POLICY_MAX_BYTES } from '../../src/conduit-mcp/policy-file-fs';

const faults = vi.hoisted(() => ({ rename: false, growFile: '', reads: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      const stat = actual.fstatSync(...args);
      if (faults.growFile) actual.appendFileSync(faults.growFile, 'extra');
      return stat;
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      faults.reads++;
      return actual.readSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (faults.rename) throw Object.assign(new Error('rename failed'), { code: 'EIO' });
      return actual.renameSync(...args);
    },
  };
});
const dirs: string[] = [];
afterEach(() => {
  faults.rename = false;
  faults.growFile = '';
  faults.reads = 0;
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
  it('preserves the previous policy bytes and cleans temp files when actual promotion fails', () => {
    const file = location();
    const io = createPolicyIo(file);
    io.writeSync('prior policy');
    faults.rename = true;
    expect(() => io.writeSync('new policy')).toThrow('rename failed');
    expect(fs.readFileSync(file, 'utf8')).toBe('prior policy');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['policy.json']);
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

it('supports an explicit owner cap while preserving old bytes on over-cap intent', () => {
  const file = location();
  const io = createPolicyIo(file, { maxBytes: POLICY_MAX_BYTES + 100 });
  const text = 'x'.repeat(POLICY_MAX_BYTES + 1);
  expect(io.writeSync(text)).toBe(true);
  expect(() => io.writeSync(text + 'x'.repeat(100))).toThrow(/large/);
  expect(io.read()).toBe(text);
});

it('rejects an oversized sparse file before reading its contents', () => {
  const file = location();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 9);
  fs.closeSync(fd);
  expect(() => createPolicyIo(file, { maxBytes: 8 }).read()).toThrow(/large/);
  expect(faults.reads).toBe(0);
});

it('rejects a file that grows beyond the cap after its size check', () => {
  const file = location();
  const io = createPolicyIo(file, { maxBytes: 8 });
  io.writeSync('12345678');
  faults.growFile = file;
  expect(() => io.read()).toThrow(/large/);
});

it('decodes UTF-8 at the byte cap', () => {
  const file = location();
  const io = createPolicyIo(file, { maxBytes: 4 });
  io.writeSync('éé');
  expect(io.read()).toBe('éé');
});
