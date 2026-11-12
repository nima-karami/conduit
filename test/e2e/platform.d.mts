// Only the surface unit tests import; the module is plain JS.
export function e2ePlatformSupported(platform?: string): boolean;
export function defaultShellAgent(platform?: string): 'shell:cmd' | 'shell:bash';
export function parseSttySize(text: string): { rows: number; cols: number } | null;
export function windowsOnlySkipMessage(
  name: string,
  reason: string,
  platform?: string,
): string | null;
export function uriPathKey(p: string, platform?: string): string;
export function shellPromptPattern(platform?: string): RegExp;
export function isShellPromptLine(line: string, platform?: string): boolean;
