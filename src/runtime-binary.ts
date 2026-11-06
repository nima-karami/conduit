export function runtimeBinaryName(name: 'node' | 'hc', platform: NodeJS.Platform): string {
  const binary = name === 'hc' ? 'conduit-hc' : name;
  return platform === 'win32' ? `${binary}.exe` : binary;
}
