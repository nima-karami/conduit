import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensurePinned, type RuntimePin } from '../../build/fetch-runtime.mjs';
import pins from '../../build/runtime-pins.json';

const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

let vendorDir: string;
beforeEach(() => {
  vendorDir = mkdtempSync(join(tmpdir(), 'fetch-runtime-'));
});
afterEach(() => rmSync(vendorDir, { recursive: true, force: true }));

const serving = (bytes: string) =>
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

describe('build/runtime-pins.json', () => {
  it('pins node and hc by version and sha256', () => {
    for (const pin of Object.values(pins) as RuntimePin[]) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.url).toMatch(/^https:\/\//);
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pins.node.version).toBe('24.18.0');
    expect(pins.hc.version).toBe('0.1.16');
  });
});
