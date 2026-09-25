import * as path from 'node:path';
import { osFileClipboardSupported } from './drag-out-policy';
import type { HostPlatform } from './lsp-binary';

export interface PowerShellSpawn {
  file: string;
  args: string[];
  stdin: string;
}
export type OsClipboardPayload =
  | { kind: 'powershell'; spawn: PowerShellSpawn }
  | { kind: 'plist'; format: 'NSFilenamesPboardType'; xml: string }
  | { kind: 'unsupported' }
  /** No SystemRoot on win32, or a darwin name the plist can't carry. */
  | { kind: 'unavailable'; detail: string };

// Paths arrive on stdin as base64 of UTF-8 JSON: PowerShell 5.1 decodes stdin in the OEM
// codepage, so raw non-ASCII names would be mangled (os-drag-out spec §2.3). S0 F4 runs this
// exact text; change it only with a re-run.
export const SET_CLIPBOARD_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$b64=[Console]::In.ReadToEnd().Trim()',
  '$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))',
  '$p=[string[]](ConvertFrom-Json $json)',
  'Set-Clipboard -LiteralPath $p',
].join('; ');

export function buildPowerShellClipboardSpawn(
  paths: readonly string[],
  systemRoot: string,
): PowerShellSpawn {
  return {
    file: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-Sta', '-NoProfile', '-NonInteractive', '-Command', SET_CLIPBOARD_SCRIPT],
    stdin: Buffer.from(JSON.stringify(paths), 'utf8').toString('base64'),
  };
}

export function decodeClipboardStdin(stdin: string): string[] {
  const v: unknown = JSON.parse(Buffer.from(stdin, 'base64').toString('utf8'));
  if (!Array.isArray(v) || v.some((p) => typeof p !== 'string')) {
    throw new Error('clipboard stdin is not a string array');
  }
  return v;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

// Outside the XML 1.0 Char production: C0 controls other than tab/LF/CR, and U+FFFE/U+FFFF.
function xmlCanCarry(p: string): boolean {
  for (const ch of p) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff) {
      return false;
    }
  }
  return true;
}

export function buildFilenamesPlist(paths: readonly string[]): string {
  const items = paths
    .map((p) => `<string>${p.replace(/[&<>"']/g, (c) => XML_ESCAPES[c])}</string>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' +
    `<plist version="1.0"><array>${items}</array></plist>`
  );
}

export function osClipboardPayload(
  paths: readonly string[],
  platform: HostPlatform,
  systemRoot: string | undefined,
): OsClipboardPayload {
  if (!osFileClipboardSupported(platform)) return { kind: 'unsupported' };
  if (platform === 'darwin') {
    // Escaping can't represent these; stripping them would name a different file.
    if (!paths.every(xmlCanCarry)) {
      return {
        kind: 'unavailable',
        detail: 'a name contains characters the clipboard format cannot carry',
      };
    }
    return { kind: 'plist', format: 'NSFilenamesPboardType', xml: buildFilenamesPlist(paths) };
  }
  if (!systemRoot) return { kind: 'unavailable', detail: 'SystemRoot is not set' };
  return { kind: 'powershell', spawn: buildPowerShellClipboardSpawn(paths, systemRoot) };
}
