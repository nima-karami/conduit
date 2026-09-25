import { describe, expect, it } from 'vitest';
import { osFileClipboardSupported } from '../../src/drag-out-policy';
import {
  buildFilenamesPlist,
  buildPowerShellClipboardSpawn,
  decodeClipboardStdin,
  osClipboardPayload,
  SET_CLIPBOARD_SCRIPT,
} from '../../src/os-clipboard-payload';

const hostile = [
  "C:\\w\\it's.txt",
  'C:\\w\\a;b.txt',
  'C:\\w\\$env:X.txt',
  'C:\\w\\with space\\f.txt',
  'C:\\w\\日本.txt',
];

describe('buildPowerShellClipboardSpawn', () => {
  const spawn = buildPowerShellClipboardSpawn(hostile, 'C:\\Windows');

  it('paths never in argv', () => {
    for (const a of spawn.args) for (const p of hostile) expect(a.includes(p)).toBe(false);
    expect(spawn.args.join(' ')).not.toMatch(/日本|it's|\$env:X/);
  });

  it('stdin round-trips', () => {
    expect(decodeClipboardStdin(spawn.stdin)).toEqual(hostile);
  });

  it('stdin is pure base64 ASCII', () => {
    expect(spawn.stdin).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('absolute Windows PowerShell 5.1', () => {
    expect(spawn.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('fixed args around the fixed script', () => {
    expect(spawn.args).toEqual([
      '-Sta',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      SET_CLIPBOARD_SCRIPT,
    ]);
    expect(SET_CLIPBOARD_SCRIPT).toContain('Set-Clipboard -LiteralPath');
    expect(SET_CLIPBOARD_SCRIPT).toContain("$ErrorActionPreference='Stop'");
  });
});

describe('decodeClipboardStdin', () => {
  it('rejects a payload that is not a string array', () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
    expect(() => decodeClipboardStdin(enc({ a: 1 }))).toThrow();
    expect(() => decodeClipboardStdin(enc(['a', 2]))).toThrow();
  });
});

describe('buildFilenamesPlist', () => {
  it('plist escapes', () => {
    const xml = buildFilenamesPlist(['/a&<b>.txt']);
    expect(xml).toContain('/a&amp;&lt;b&gt;.txt');
    const array = xml.match(/<array>([\s\S]*)<\/array>/);
    expect(array).not.toBeNull();
    expect(array?.[1].match(/<string>/g)).toHaveLength(1);
  });

  it('escapes quotes too, one string per path', () => {
    const xml = buildFilenamesPlist([`/q"'.txt`, '/b']);
    expect(xml).toContain('<string>/q&quot;&apos;.txt</string>');
    expect(xml.match(/<string>/g)).toHaveLength(2);
    expect(xml.startsWith('<?xml')).toBe(true);
  });
});

describe('osClipboardPayload', () => {
  it('linux → unsupported', () => {
    expect(osClipboardPayload(['/a'], 'linux', undefined)).toEqual({ kind: 'unsupported' });
  });

  it('darwin → plist', () => {
    expect(osClipboardPayload(['/a'], 'darwin', undefined)).toEqual({
      kind: 'plist',
      format: 'NSFilenamesPboardType',
      xml: buildFilenamesPlist(['/a']),
    });
  });

  it.runIf(osFileClipboardSupported('win32'))('win32 → powershell', () => {
    expect(osClipboardPayload(['C:\\a'], 'win32', 'C:\\Windows')).toEqual({
      kind: 'powershell',
      spawn: buildPowerShellClipboardSpawn(['C:\\a'], 'C:\\Windows'),
    });
  });

  it.runIf(osFileClipboardSupported('win32'))(
    'win32 with an undefined systemRoot → unavailable',
    () => {
      expect(osClipboardPayload(['C:\\a'], 'win32', undefined)).toMatchObject({
        kind: 'unavailable',
      });
    },
  );

  it.runIf(!osFileClipboardSupported('win32'))('win32 unsupported until S0 F4 passes', () => {
    expect(osClipboardPayload(['C:\\a'], 'win32', 'C:\\Windows')).toEqual({ kind: 'unsupported' });
  });
});
