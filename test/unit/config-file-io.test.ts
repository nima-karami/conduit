import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupOnce,
  type ConfigIo,
  errorCodeOf,
  readConfigFile,
  writeConfigAtomic,
} from '../../electron/config-file-io';
import { ConfigFormatError } from '../../src/conduit-mcp/install-types';

const roots: string[] = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-cfgio-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const BOM = String.fromCharCode(0xfeff);

describe('readConfigFile', () => {
  it('missing file → text null, realPath = given', () => {
    const file = path.join(tmp(), 'nope', 'x.json');
    const r = readConfigFile(fs, file);
    expect(r).toMatchObject({ text: null, raw: null, realPath: file, bom: false });
    expect(r.mode).toBeUndefined();
  });

  it('BOM stripped and flagged', () => {
    const file = path.join(tmp(), 'x.json');
    fs.writeFileSync(file, `${BOM}{"a":1}`);
    const r = readConfigFile(fs, file);
    expect(r.text).toBe('{"a":1}');
    expect(r.bom).toBe(true);
    expect(r.raw?.equals(fs.readFileSync(file))).toBe(true);
    expect(r.size).toBe(fs.statSync(file).size);
    expect(r.mtimeMs).toBe(fs.statSync(file).mtimeMs);
  });

  it('a file without a BOM reads verbatim', () => {
    const file = path.join(tmp(), 'x.json');
    fs.writeFileSync(file, '{}\n');
    expect(readConfigFile(fs, file)).toMatchObject({ text: '{}\n', bom: false });
  });

  it.skipIf(process.platform === 'win32')(
    'symlinked file reads the target and reports its realpath',
    () => {
      const dir = tmp();
      const target = path.join(dir, 'managed.json');
      fs.writeFileSync(target, '{"t":1}');
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(target, link);
      const r = readConfigFile(fs, link);
      expect(r.text).toBe('{"t":1}');
      expect(r.realPath).toBe(fs.realpathSync(target));
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a dangling symlink is an error, not a missing file',
    () => {
      const dir = tmp();
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(path.join(dir, 'gone.json'), link);
      expect(() => readConfigFile(fs, link)).toThrow();
    },
  );
});

describe('writeConfigAtomic', () => {
  it('creates the parent dir and writes the data', () => {
    const file = path.join(tmp(), 'a', 'b', 'x.json');
    writeConfigAtomic(fs, file, '{}\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('{}\n');
  });

  it.skipIf(process.platform === 'win32')('atomic write keeps mode 0600', () => {
    const file = path.join(tmp(), 'x.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o600);
    writeConfigAtomic(fs, file, '{"a":1}\n', fs.statSync(file).mode & 0o7777);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n');
  });

  it('failed rename unlinks the temp', () => {
    const dir = tmp();
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, 'old');
    const io: ConfigIo = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
    };
    expect(() => writeConfigAtomic(io, file, 'new')).toThrow(/denied/);
    expect(fs.readdirSync(dir)).toEqual(['x.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
  });
});

describe('backupOnce', () => {
  it('backupOnce never overwrites; null original writes "null"; EEXIST race is success', () => {
    const dir = tmp();
    const backup = path.join(dir, 'deep', 'x.json.conduit-backup');
    backupOnce(fs, backup, null);
    expect(fs.readFileSync(backup, 'utf8')).toBe('null');
    backupOnce(fs, backup, Buffer.from('second'));
    expect(fs.readFileSync(backup, 'utf8')).toBe('null');

    const raced = path.join(dir, 'raced.conduit-backup');
    const racing: ConfigIo = {
      ...fs,
      existsSync: () => false,
      linkSync: (from, to) => {
        fs.writeFileSync(to, 'other creator');
        fs.linkSync(from, to);
      },
    };
    expect(() => backupOnce(racing, raced, Buffer.from('mine'))).not.toThrow();
    expect(fs.readFileSync(raced, 'utf8')).toBe('other creator');
    expect(fs.readdirSync(dir).sort()).toEqual(['deep', 'raced.conduit-backup']);
  });

  it('falls back to an exclusive copy when hard links fail', () => {
    const dir = tmp();
    const backup = path.join(dir, 'x.conduit-backup');
    const noLinks: ConfigIo = {
      ...fs,
      linkSync: () => {
        throw Object.assign(new Error('no links'), { code: 'EPERM' });
      },
    };
    backupOnce(noLinks, backup, Buffer.from('orig'));
    expect(fs.readFileSync(backup, 'utf8')).toBe('orig');
    expect(fs.readdirSync(dir)).toEqual(['x.conduit-backup']);
  });
});

describe('errorCodeOf', () => {
  it('maps OS codes, ConfigFormatError codes, else EINVAL', () => {
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('EACCES');
    expect(errorCodeOf(new ConfigFormatError('ETOML', 'bad'))).toBe('ETOML');
    expect(errorCodeOf(new Error('plain'))).toBe('EINVAL');
    expect(errorCodeOf('string')).toBe('EINVAL');
  });
});
