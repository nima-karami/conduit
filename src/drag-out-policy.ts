import type { HostPlatform } from './lsp-binary';

// win32 is S0 F4's verdict: PASS (docs/runs/2026-09-24-os-drag-out/s0-spike.md). The e2e's
// WIN32_OS_CLIPBOARD mirrors it; flip both together.
const OS_FILE_CLIPBOARD: Readonly<Record<HostPlatform, boolean>> = {
  win32: true,
  darwin: true,
  linux: false,
};

export const OS_CLIPBOARD_TIMEOUT_MS = 10_000;
/** One write in flight plus the one pending behind it (electron/os-file-clipboard.ts), with margin. */
export const OS_CLIPBOARD_REPLY_TIMEOUT_MS = 2 * OS_CLIPBOARD_TIMEOUT_MS + 5_000;

export function osFileClipboardSupported(platform: HostPlatform): boolean {
  return OS_FILE_CLIPBOARD[platform];
}

export function platformFromNavigator(navPlatform: string): HostPlatform {
  if (/^Win/.test(navPlatform)) return 'win32';
  if (/^Mac/.test(navPlatform)) return 'darwin';
  return 'linux';
}
