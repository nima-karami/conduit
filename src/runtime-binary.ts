export function runtimeBinaryName(name: 'node' | 'hc', platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}
