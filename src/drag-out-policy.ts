import type { HostPlatform } from './lsp-binary';

// win32 is S0 F4's verdict (os-drag-out plan, branch table). F4 is unmeasured, and unmeasured
// counts as FAIL, so it stays false until the spike records a PASS.
const OS_FILE_CLIPBOARD: Readonly<Record<HostPlatform, boolean>> = {
  win32: false,
  darwin: true,
  linux: false,
};

export function osFileClipboardSupported(platform: HostPlatform): boolean {
  return OS_FILE_CLIPBOARD[platform];
}

export function platformFromNavigator(navPlatform: string): HostPlatform {
  if (/^Win/.test(navPlatform)) return 'win32';
  if (/^Mac/.test(navPlatform)) return 'darwin';
  return 'linux';
}
