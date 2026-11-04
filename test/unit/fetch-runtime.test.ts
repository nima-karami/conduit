import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePinned, fetchRuntime, type RuntimePin } from '../../build/fetch-runtime.mjs';
import pins from '../../build/runtime-pins.json';

const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

let vendorDir: string;
beforeEach(() => {
  vendorDir = mkdtempSync(join(tmpdir(), 'fetch-runtime-'));
});
afterEach(() => rmSync(vendorDir, { recursive: true, force: true }));

const serving = (bytes: string | Buffer) =>
  vi.fn(async (_url: string, file: string) => {
    writeFileSync(file, bytes);
  });

/** Stands in for tar/unzip: the "zip" is a JSON map of entry → contents. */
const fakeExtract = vi.fn(async (zip: string, dir: string) => {
  const entries = JSON.parse(readFileSync(zip, 'utf8')) as Record<string, string>;
  for (const [name, content] of Object.entries(entries)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
});

const filePin = (bytes: string): RuntimePin => ({
  version: '1.0.0',
  url: 'https://example.test/node.exe',
  sha256: sha(bytes),
  dest: 'node/node.exe',
});

const zipBytes = JSON.stringify({ 'herdr-core.exe': 'hc', 'conpty/conpty.dll': 'dll' });
const zipPin: RuntimePin = {
  version: '1.0.0',
  url: 'https://example.test/hc.zip',
  sha256: sha(zipBytes),
  dest: 'hc',
  archive: 'zip',
  rename: { 'herdr-core.exe': 'hc.exe' },
};

describe('ensurePinned (file)', () => {
  it('fails on a hash mismatch and leaves no file behind', async () => {
    const download = serving('tampered');
    await expect(
      ensurePinned(filePin('genuine'), { vendorDir, download, extractZip: fakeExtract }),
    ).rejects.toThrow(/sha256/);
    expect(existsSync(join(vendorDir, 'node', 'node.exe'))).toBe(false);
    expect(readdirSync(join(vendorDir, 'node'))).toEqual([]);
  });

  it('skips the download when the pinned file is present and matches', async () => {
    mkdirSync(join(vendorDir, 'node'));
    writeFileSync(join(vendorDir, 'node', 'node.exe'), 'genuine');
    const download = serving('genuine');
    const result = await ensurePinned(filePin('genuine'), { vendorDir, download });
    expect(result).toBe('skipped');
    expect(download).not.toHaveBeenCalled();
  });

  it('replaces a present file whose hash does not match', async () => {
    mkdirSync(join(vendorDir, 'node'));
    writeFileSync(join(vendorDir, 'node', 'node.exe'), 'stale');
    const result = await ensurePinned(filePin('genuine'), {
      vendorDir,
      download: serving('genuine'),
    });
    expect(result).toBe('fetched');
    expect(readFileSync(join(vendorDir, 'node', 'node.exe'), 'utf8')).toBe('genuine');
  });
});

describe('ensurePinned (zip)', () => {
  it('fails on a hash mismatch before extracting and leaves nothing behind', async () => {
    fakeExtract.mockClear();
    await expect(
      ensurePinned(zipPin, { vendorDir, download: serving('tampered'), extractZip: fakeExtract }),
    ).rejects.toThrow(/sha256/);
    expect(fakeExtract).not.toHaveBeenCalled();
    expect(readdirSync(vendorDir)).toEqual([]);
  });

  it('extracts, applies the renames, and skips the next run', async () => {
    const download = serving(zipBytes);
    expect(await ensurePinned(zipPin, { vendorDir, download, extractZip: fakeExtract })).toBe(
      'fetched',
    );
    expect(readFileSync(join(vendorDir, 'hc', 'hc.exe'), 'utf8')).toBe('hc');
    expect(existsSync(join(vendorDir, 'hc', 'herdr-core.exe'))).toBe(false);
    expect(readFileSync(join(vendorDir, 'hc', 'conpty', 'conpty.dll'), 'utf8')).toBe('dll');
    expect(readdirSync(vendorDir).sort()).toEqual(['hc', 'hc.sha256']);

    download.mockClear();
    expect(await ensurePinned(zipPin, { vendorDir, download, extractZip: fakeExtract })).toBe(
      'skipped',
    );
    expect(download).not.toHaveBeenCalled();
  });
});

describe('ensurePinned (tar.gz)', () => {
  const bytes = JSON.stringify({ 'bin/node': 'node', LICENSE: 'license' });
  const pin = {
    version: '24.18.0',
    url: 'https://example.test/node.tar.gz',
    sha256: sha(bytes),
    dest: 'node',
    archive: 'tar.gz',
    stripComponents: 1,
    rename: { 'bin/node': 'node' },
  } as const;

  it('verifies before extraction and removes an invalid archive', async () => {
    const extractTar = vi.fn(async (archive: string, dir: string) => fakeExtract(archive, dir));
    await expect(
      ensurePinned(pin, { vendorDir, download: serving('bad'), extractTar }),
    ).rejects.toThrow(/sha256/);
    expect(extractTar).not.toHaveBeenCalled();
    expect(readdirSync(vendorDir)).toEqual([]);
  });

  it('extracts a verified archive with its prefix stripped, renames node and reuses it', async () => {
    const extractTar = vi.fn(async (archive: string, dir: string) => fakeExtract(archive, dir));
    const download = serving(bytes);
    expect(await ensurePinned(pin, { vendorDir, download, extractTar })).toBe('fetched');
    expect(readFileSync(join(vendorDir, 'node', 'node'), 'utf8')).toBe('node');
    expect(readFileSync(join(vendorDir, 'node', 'LICENSE'), 'utf8')).toBe('license');
    expect(extractTar).toHaveBeenCalledWith(expect.any(String), expect.any(String), 1);
    expect(await ensurePinned(pin, { vendorDir, download, extractTar })).toBe('skipped');
    expect(download).toHaveBeenCalledTimes(1);
    expect(readdirSync(vendorDir).sort()).toEqual(['node', 'node.sha256']);
  });

  it('uses system tar to strip the Node prefix and preserves executable mode through rename', async () => {
    const source = join(vendorDir, 'source');
    mkdirSync(join(source, 'node-dist', 'bin'), { recursive: true });
    writeFileSync(join(source, 'node-dist', 'bin', 'node'), 'executable');
    chmodSync(join(source, 'node-dist', 'bin', 'node'), 0o755);
    writeFileSync(join(source, 'node-dist', 'LICENSE'), 'license');
    const archive = join(vendorDir, 'fixture.tar.gz');
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    execFileSync(tar, ['-czf', archive, '-C', source, 'node-dist']);
    const contents = readFileSync(archive);
    const realPin = { ...pin, sha256: createHash('sha256').update(contents).digest('hex') };
    await ensurePinned(realPin, { vendorDir, download: serving(contents) });
    const binary = join(vendorDir, 'node', 'node');
    expect(readFileSync(binary, 'utf8')).toBe('executable');
    expect(readFileSync(join(vendorDir, 'node', 'LICENSE'), 'utf8')).toBe('license');
    if (process.platform !== 'win32') expect(statSync(binary).mode & 0o777).toBe(0o755);
  });

  it('cleans up after extraction fails and leaves a previously fetched runtime intact', async () => {
    mkdirSync(join(vendorDir, 'node'));
    writeFileSync(join(vendorDir, 'node', 'node'), 'previous');
    writeFileSync(join(vendorDir, 'node.sha256'), 'old-sha');
    await expect(
      ensurePinned(pin, {
        vendorDir,
        download: serving(bytes),
        extractTar: async () => {
          throw new Error('invalid tar');
        },
      }),
    ).rejects.toThrow('invalid tar');
    expect(readFileSync(join(vendorDir, 'node', 'node'), 'utf8')).toBe('previous');
    expect(readdirSync(vendorDir).sort()).toEqual(['node', 'node.sha256']);
  });
});

describe('build/runtime-pins.json', () => {
  it('pins node and hc by version and sha256', () => {
    for (const pin of Object.values(pins).flatMap((set) => Object.values(set)) as RuntimePin[]) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.url).toMatch(/^https:\/\//);
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    for (const set of Object.values(pins)) {
      expect(set.node.version).toBe('24.18.0');
      expect(set.hc.version).toBe('0.1.16');
    }
    expect(pins['darwin-arm64'].node.sha256).toBe(
      'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
    );
    expect(pins['darwin-arm64'].hc.sha256).toBe(
      '698d8f0c44f4e4b15fec174d52a39d57a014cfd71added44b53a0753b469d0fd',
    );
  });

  it.each(['win32', 'darwin'] as const)('fetches only the selected %s set', async (platform) => {
    const download = serving('node');
    await fetchRuntime({
      pins: {
        'win32-x64': { node: filePin('node') },
        'darwin-arm64': { node: { ...filePin('node'), dest: 'node/node' } },
      },
      platform,
      arch: platform === 'darwin' ? 'arm64' : 'x64',
      vendorDir,
      download,
      log: () => {},
    });
    expect(readdirSync(join(vendorDir, 'node'))).toEqual([
      platform === 'win32' ? 'node.exe' : 'node',
    ]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported platforms before downloading', async () => {
    const download = serving('node');
    await expect(
      fetchRuntime({
        pins: { 'darwin-arm64': { node: filePin('node') } },
        platform: 'darwin',
        arch: 'x64',
        vendorDir,
        download,
      }),
    ).rejects.toThrow('No pinned runtime for darwin-x64');
    expect(download).not.toHaveBeenCalled();
  });
});
