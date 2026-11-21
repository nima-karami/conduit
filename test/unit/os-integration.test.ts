import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import pkg from '../../package.json';
import { linuxIntegration, linuxRoots } from '../../src/os-integration/linux';
import { fileManagerPreference } from '../../src/os-integration/preference';
import { windowsRegistry } from '../../src/os-integration/windows';

const template = resolve('build/linux/conduit.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'conduit-file-manager-'));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function fixture(hasNautilus = false, executable = '/tmp/Con duit "é".AppImage') {
  const { data, config } = linuxRoots(home, { CONDUIT_OS_INTEGRATION_ROOT: home });
  const systemExtension = join(home, 'system', 'conduit.py');
  return {
    ...linuxIntegration({
      data,
      config,
      userData: join(home, 'profile'),
      executable,
      extension: template,
      systemExtension,
      hasNautilus: () => hasNautilus,
    }),
    extension: join(data, 'nautilus-python', 'extensions', 'conduit.py'),
    fallback: join(data, 'nautilus', 'scripts', 'Open in Conduit'),
    dolphin: join(data, 'kio', 'servicemenus', 'conduit.desktop'),
    nemo: join(data, 'nemo', 'actions', 'conduit.nemo_action'),
    thunar: join(config, 'Thunar', 'uca.xml'),
    marker: join(config, 'Conduit', 'file-manager-off'),
    systemExtension,
  };
}

test('uses absolute XDG overrides and standard home defaults', () => {
  expect(linuxRoots(home, { XDG_DATA_HOME: 'relative' })).toEqual({
    data: join(home, '.local/share'),
    config: join(home, '.config'),
  });
  const data = join(home, 'custom');
  expect(linuxRoots(home, { XDG_DATA_HOME: data }).data).toBe(data);
});

test('installs idempotently, merges Thunar, and only removes owned artifacts', () => {
  const os = fixture();
  const original =
    '<?xml version="1.0"?>\n<actions>\n<!-- <action>fake</action> -->\n<action><name>Other &amp; Co</name><unique-id>123</unique-id></action>\n</actions>\n';
  mkdirSync(dirname(os.thunar), { recursive: true });
  writeFileSync(os.thunar, original);
  expect(os.status()).toEqual({ enabled: false });
  expect(os.setEnabled(true)).toEqual({ enabled: true, notice: 'missing-nautilus' });
  const paths = [os.extension, os.fallback, os.dolphin, os.nemo, os.thunar];
  const contents = paths.map((file) => readFileSync(file, 'utf8'));
  os.setEnabled(true);
  expect(paths.map((file) => readFileSync(file, 'utf8'))).toEqual(contents);
  expect(contents[0]).toContain('EXECUTABLE = "/tmp/Con duit \\"é\\".AppImage"');
  expect(contents[2]).toContain('%F');
  expect(contents[3]).toContain('Quote=double');
  expect(contents[4]).toContain('<unique-id>com.nimakarami.conduit.open</unique-id>');
  if (process.platform !== 'win32') {
    expect(statSync(os.fallback).mode & 0o111).toBe(0o111);
    expect(statSync(os.dolphin).mode & 0o111).toBe(0o111);
  }

  writeFileSync(os.nemo, 'user replaced this action');
  expect(os.setEnabled(false)).toEqual({ enabled: false, notice: 'restart-files' });
  expect(paths.slice(0, 3).some(existsSync)).toBe(false);
  expect(readFileSync(os.nemo, 'utf8')).toBe('user replaced this action');
  expect(readFileSync(os.thunar, 'utf8')).toBe(original);
  expect(existsSync(os.marker)).toBe(true);
});

test('recognizes the packaged extension and persists its per-user off marker', () => {
  const os = fixture(true);
  mkdirSync(dirname(os.systemExtension), { recursive: true });
  writeFileSync(os.systemExtension, 'installed');
  expect(os.status()).toEqual({ enabled: true });
  expect(os.setEnabled(false).enabled).toBe(false);
  expect(fixture(true).status()).toEqual({ enabled: false });
  expect(readFileSync(os.systemExtension, 'utf8')).toBe('installed');
  expect(os.setEnabled(true)).toEqual({ enabled: true, notice: 'restart-files' });
  expect(existsSync(os.marker)).toBe(false);
  expect(existsSync(os.fallback)).toBe(false);
  expect(os.setEnabled(false).enabled).toBe(false);
  expect(existsSync(os.thunar)).toBe(false);
});

test('prefers the system Nautilus extension and removes redundant owned copies', () => {
  const os = fixture();
  os.setEnabled(true);
  expect(existsSync(os.extension)).toBe(true);
  expect(existsSync(os.fallback)).toBe(true);

  mkdirSync(dirname(os.systemExtension), { recursive: true });
  writeFileSync(os.systemExtension, 'packaged extension');
  expect(os.setEnabled(true)).toEqual({ enabled: true, notice: 'missing-nautilus' });
  expect(existsSync(os.extension)).toBe(false);
  expect(existsSync(os.fallback)).toBe(false);
  expect(existsSync(os.dolphin)).toBe(true);
  expect(existsSync(os.nemo)).toBe(true);
  expect(existsSync(os.thunar)).toBe(true);
  expect(readFileSync(os.systemExtension, 'utf8')).toBe('packaged extension');
});

test('restores an explicit Linux off choice at startup when managed files reappear', async () => {
  const os = fixture();
  const profile = join(home, 'profile');
  const preference = fileManagerPreference(profile, os);
  os.setEnabled(true);
  const managed = [os.extension, os.fallback, os.dolphin, os.nemo, os.thunar];
  const snapshot = managed.map((file) => readFileSync(file, 'utf8'));
  await preference.reconcileStartup();
  expect(managed.every(existsSync)).toBe(true);

  await preference.setEnabled(false);
  for (const [index, file] of managed.entries()) writeFileSync(file, snapshot[index]);
  rmSync(os.marker);
  const nextRun = fileManagerPreference(profile, fixture());
  await nextRun.reconcileStartup();
  expect(managed.some(existsSync)).toBe(false);
  expect(existsSync(os.marker)).toBe(true);
  expect(await nextRun.status()).toEqual({ enabled: false });
});

test('preserves a preexisting, unowned action at a reserved filename', () => {
  const os = fixture();
  mkdirSync(dirname(os.extension), { recursive: true });
  writeFileSync(os.extension, 'user extension');
  expect(() => os.setEnabled(true)).toThrow('A file already exists');
  os.setEnabled(false);
  expect(readFileSync(os.extension, 'utf8')).toBe('user extension');
});

test.skipIf(!hasPython)('compiles the extension and launches Nautilus selections as argv', () => {
  const os = fixture();
  os.setEnabled(true);
  const compile = spawnSync('python3', ['-m', 'py_compile', os.extension], { encoding: 'utf8' });
  expect(compile.stderr).toBe('');
  expect(compile.status).toBe(0);
  const probe = spawnSync(
    'python3',
    ['test/fixtures/file-manager-nautilus.py', os.extension, dirname(dirname(os.marker))],
    { encoding: 'utf8' },
  );
  expect(probe.stderr).toBe('');
  expect(probe.status).toBe(0);
  expect(JSON.parse(probe.stdout)).toEqual([
    ['/tmp/Con duit "é".AppImage', '/a space/é".txt', "/x'\nsecond"],
    ['/tmp/Con duit "é".AppImage', "/x'\nsecond"],
  ]);
});

test.skipIf(!hasPython || process.platform === 'win32')(
  'Scripts fallback preserves newlines by preferring the URI list',
  () => {
    const target = join(home, 'Conduit é ".AppImage');
    writeFileSync(
      target,
      '#!/usr/bin/env python3\nimport json, sys\nprint(json.dumps(sys.argv))\n',
      {
        mode: 0o755,
      },
    );
    const os = fixture(false, target);
    os.setEnabled(true);
    const files = [join(home, 'file " é.txt'), join(home, "newline'\nname")];
    const launched = spawnSync(os.fallback, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NAUTILUS_SCRIPT_SELECTED_FILE_PATHS: files.join('\n'),
        NAUTILUS_SCRIPT_SELECTED_URIS: files.map((file) => pathToFileURL(file).href).join('\n'),
      },
    });
    expect(launched.stderr).toBe('');
    expect(launched.status).toBe(0);
    expect(JSON.parse(launched.stdout)).toEqual([target, ...files]);
  },
);

test('Windows runtime matches installer keys, values and uninstall targets', () => {
  const executable = 'C:\\Test Folder\\Conduit.exe';
  const nsis = readFileSync('build/installer.nsh', 'utf8')
    .replaceAll(/\$\{APP_EXECUTABLE_FILENAME\}/g, 'Conduit.exe')
    .replaceAll('$INSTDIR\\Conduit.exe', executable)
    .replaceAll(/\$\{CONDUIT_DOC_PROGID\}/g, 'Conduit.Document');
  const sourceExts = [...nsis.matchAll(/!insertmacro \$\{_cmd\} "(.*?)"/g)].map((m) => m[1]);
  const expected = [
    ...nsis.matchAll(/WriteRegStr HKCU "([^"]+)" "([^"]*)" (?:"([^"]*)"|'([^']*)')/g),
  ].flatMap(([, key, name, quoted, command]) =>
    (/^\$\{_ext\}$/.test(name) ? sourceExts : [name]).map((name) => ({
      key,
      name,
      value: quoted ?? command,
    })),
  );
  const registry = windowsRegistry(executable);
  expect(registry.values).toHaveLength(expected.length);
  expect(registry.values).toEqual(expect.arrayContaining(expected));
  expect(registry.keys).toEqual(
    [...nsis.matchAll(/DeleteRegKey HKCU "([^"]+)"/g)].map((m) => m[1]),
  );
  expect(nsis).toContain(`DeleteRegValue HKCU "${registry.registered}" "Conduit"`);
});

test('deb ships the same Nautilus template and registers desktop file types', () => {
  expect(pkg.build.deb.recommends).toContain('python3-nautilus');
  expect(pkg.build.deb.fpm).toContain(
    'build/linux/conduit.py=/usr/share/nautilus-python/extensions/conduit.py',
  );
  expect(pkg.build.deb.executableArgs).toEqual(['%F']);
  expect(pkg.build.linux.extraResources).toContainEqual({
    from: 'build/linux/conduit.py',
    to: 'file-manager/conduit.py',
  });
  expect(pkg.build.deb.mimeTypes).toEqual(
    expect.arrayContaining(['inode/directory', 'text/plain', 'application/pdf']),
  );
  expect(readFileSync(template, 'utf8')).toContain('EXECUTABLE = "/usr/bin/conduit"');
});
