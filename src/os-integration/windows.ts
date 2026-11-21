import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import type { FileManagerStatus } from './status';

const extensions = [
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.toml',
  '.xml',
  '.csv',
  '.log',
  '.ini',
  '.env',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.py',
  '.rs',
  '.go',
  '.rb',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.sql',
  '.gitignore',
  '.dockerfile',
  '.pdf',
];

interface RegistryValue {
  key: string;
  name: string;
  value: string;
}

export function windowsRegistry(executable: string) {
  const directory = 'Software\\Classes\\Directory\\shell\\Conduit';
  const background = 'Software\\Classes\\Directory\\Background\\shell\\Conduit';
  const files = 'Software\\Classes\\*\\shell\\Conduit';
  const application = `Software\\Classes\\Applications\\${win32.basename(executable)}`;
  const document = 'Software\\Classes\\Conduit.Document';
  const capabilities = 'Software\\Conduit\\Capabilities';
  const registered = 'Software\\RegisteredApplications';
  const command = (arg: string) => `"${executable}" "${arg}"`;
  const entry = (key: string, name: string, value: string): RegistryValue => ({ key, name, value });
  const values = [
    ...[directory, background, files].flatMap((key) => [
      entry(key, '', key === files ? 'Open with Conduit' : 'Open in Conduit'),
      entry(key, 'Icon', executable),
      entry(`${key}\\command`, '', command(key === background ? '%V' : '%1')),
    ]),
    entry(application, 'FriendlyAppName', 'Conduit'),
    entry(`${application}\\shell\\open`, 'FriendlyAppName', 'Conduit'),
    entry(`${application}\\shell\\open\\command`, '', command('%1')),
    ...extensions.map((ext) => entry(`${application}\\SupportedTypes`, ext, '')),
    entry(document, '', 'Conduit Document'),
    entry(`${document}\\DefaultIcon`, '', `${executable},0`),
    entry(`${document}\\shell\\open\\command`, '', command('%1')),
    entry(capabilities, 'ApplicationName', 'Conduit'),
    entry(capabilities, 'ApplicationDescription', 'Open files and folders in Conduit.'),
    ...extensions.map((ext) => entry(`${capabilities}\\FileAssociations`, ext, 'Conduit.Document')),
    entry(registered, 'Conduit', capabilities),
  ];
  return {
    values,
    keys: [directory, background, files, application, document, 'Software\\Conduit'],
    registered,
  };
}

const exec = promisify(execFile);

export function windowsIntegration(executable: string, root = 'HKCU') {
  const registry = windowsRegistry(executable);
  const fullKey = (key: string) => `${root}\\${key}`;
  const regExe = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const reg = (args: string[]) => exec(regExe, args, { windowsHide: true });
  const valueArg = (name: string) => (name ? ['/v', name] : ['/ve']);

  async function exists(key: string, value?: string): Promise<boolean> {
    try {
      await reg(['query', fullKey(key), ...(value === undefined ? [] : valueArg(value))]);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }

  async function status(): Promise<FileManagerStatus> {
    // The final written value indicates registration completed even if an earlier write was retried.
    return { enabled: await exists(registry.registered, 'Conduit') };
  }

  async function setEnabled(enabled: boolean): Promise<FileManagerStatus> {
    if (enabled) {
      for (const { key, name, value } of registry.values) {
        const data =
          key === registry.registered && root !== 'HKCU'
            ? fullKey(value).slice('HKCU\\'.length)
            : value;
        await reg(['add', fullKey(key), ...valueArg(name), '/t', 'REG_SZ', '/d', data, '/f']);
      }
    } else {
      await reconcileOff();
    }
    return status();
  }

  async function reconcileOff(): Promise<void> {
    if (await exists(registry.registered, 'Conduit')) {
      await reg(['delete', fullKey(registry.registered), '/v', 'Conduit', '/f']);
    }
    for (const key of registry.keys) {
      if (await exists(key)) await reg(['delete', fullKey(key), '/f']);
    }
  }

  return { status, setEnabled, reconcileOff };
}
