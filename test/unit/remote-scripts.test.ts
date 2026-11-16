import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadCommand,
  ensureCommand,
  FAMILY_PROBE,
  finalizeCommand,
  type ManifestEntry,
  type PinFile,
  type ProbeResult,
  parseFamily,
  parseProbe,
  parseResultLine,
  probeCommand,
  type RemoteCommand,
  receiveFileCommand,
  receiveTreeCommand,
  type ShellFamily,
  startMethodOf,
} from '../../src/network/remote-scripts';

const posix = process.platform !== 'win32';
const hasSh = (): boolean => spawnSync('sh', ['-c', 'true']).status === 0;
const hasCurl = spawnSync('sh', ['-c', 'command -v curl']).status === 0;
const hasPwsh = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).status === 0;

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remote-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs a RemoteCommand exactly as a remote login shell would: `sh -c <command>`. */
function runSh(
  command: RemoteCommand,
  opts: { env?: NodeJS.ProcessEnv; input?: Buffer } = {},
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('sh', ['-c', command.command], {
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The decoded -EncodedCommand script, for builder assertions (pwsh is not required). */
function decodePs(command: RemoteCommand): string {
  const marker = '-EncodedCommand ';
  const at = command.command.indexOf(marker);
  expect(at).toBeGreaterThan(0);
  return Buffer.from(command.command.slice(at + marker.length), 'base64').toString('utf16le');
}

describe('family detection', () => {
  it('reads the sh, PowerShell and cmd.exe samples from the family probe', () => {
    expect(parseFamily('CONDUIT_FAMILY_2_%OS%_\n')).toBe('sh');
    expect(
      parseFamily('CONDUIT_FAMILY_2_%OS%_C:\\Windows\\System32\\WindowsPowerShell\\v1.0\n'),
    ).toBe('powershell');
    expect(parseFamily('CONDUIT_FAMILY_$((1+1))_Windows_NT_$PSHOME\r\n')).toBe('cmd');
  });

  it('returns null for output that carries no family line', () => {
    expect(parseFamily('')).toBeNull();
    expect(parseFamily('bash: echo: command not found\n')).toBeNull();
    expect(parseFamily('CONDUIT_FAMILY_2_%OS%_\nnoise')).toBe('sh');
  });

  it('is the decision-1 command, unchanged', () => {
    expect(FAMILY_PROBE).toBe('echo CONDUIT_FAMILY_$((1+1))_%OS%_$PSHOME');
  });
});

describe('result line', () => {
  it('takes the CONDUIT_RESULT line and ignores output before it', () => {
    const out = 'warning: noise\nCONDUIT_RESULT {"ok":true,"x":1}\n';
    expect(parseResultLine(out)).toEqual({ ok: true, x: 1 });
  });

  it('parses a failure with its step and detail', () => {
    expect(parseResultLine('CONDUIT_RESULT {"ok":false,"step":"checksum","detail":"d"}')).toEqual({
      ok: false,
      step: 'checksum',
      detail: 'd',
    });
  });

  it('returns null for a missing, malformed or unknown-step result', () => {
    expect(parseResultLine('no result here')).toBeNull();
    expect(parseResultLine('CONDUIT_RESULT {not json')).toBeNull();
    expect(parseResultLine('CONDUIT_RESULT {"ok":false,"step":"bogus","detail":"x"}')).toBeNull();
    expect(parseResultLine('CONDUIT_RESULT {"ok":"yes"}')).toBeNull();
  });
});

describe('parseProbe', () => {
  const good = {
    ok: true,
    os: 'linux',
    arch: 'x64',
    home: '/home/u',
    userData: '/home/u/.config/conduit',
    freeBytes: 1024,
    kup: false,
    linger: true,
    systemdRun: true,
    installed: ['0.1.0'],
    recorded: { version: '0.1.0', linkMajor: 1 },
    agents: ['claude'],
  };

  it('accepts a complete probe result', () => {
    const line = `CONDUIT_RESULT ${JSON.stringify(good)}`;
    const p = parseProbe(line);
    expect(p).not.toHaveProperty('error');
    expect(p).toEqual({
      os: 'linux',
      arch: 'x64',
      home: '/home/u',
      userData: '/home/u/.config/conduit',
      freeBytes: 1024,
      kup: false,
      linger: true,
      systemdRun: true,
      installed: ['0.1.0'],
      recorded: { version: '0.1.0', linkMajor: 1 },
      agents: ['claude'],
    });
  });

  it('returns bad_probe for ok:false or a field of the wrong type', () => {
    expect(parseProbe('CONDUIT_RESULT {"ok":false,"error":"probe","detail":"x"}')).toMatchObject({
      error: 'bad_probe',
    });
    expect(parseProbe(`CONDUIT_RESULT ${JSON.stringify({ ...good, arch: 'mips' })}`)).toMatchObject(
      { error: 'bad_probe' },
    );
    expect(
      parseProbe(`CONDUIT_RESULT ${JSON.stringify({ ...good, installed: 'x' })}`),
    ).toMatchObject({ error: 'bad_probe' });
    expect(parseProbe('garbage')).toMatchObject({ error: 'bad_probe' });
  });
});

describe.skipIf(!posix || !hasSh())('sh probe on this host', () => {
  function plant(home: string): string {
    const ud = join(home, '.config', 'conduit');
    mkdirSync(join(ud, 'runtime', '1.0.0'), { recursive: true });
    mkdirSync(join(ud, 'runtime', '1.0.1.tmp'), { recursive: true });
    mkdirSync(join(ud, 'runtime', 'conduit-hc', '0.1.16'), { recursive: true });
    writeFileSync(join(ud, 'server-version'), '{"version":"1.0.0","linkMajor":1}');
    return ud;
  }

  it('reports the home, the userData path and a free-bytes figure or null', () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    const ud = plant(home);
    const r = runSh(probeCommand('sh'), { env: { PATH: process.env.PATH, HOME: home } });
    const p = parseProbe(r.stdout);
    expect(p).not.toHaveProperty('error');
    if ('error' in p) return;
    expect(p.home).toBe(home);
    expect(p.userData).toBe(ud);
    expect(p.os).toBe('linux');
    expect(p.freeBytes === null || (typeof p.freeBytes === 'number' && p.freeBytes > 0)).toBe(true);
    expect(typeof p.systemdRun).toBe('boolean');
    expect(p.kup === null || typeof p.kup === 'boolean').toBe(true);
    expect(p.linger === null || typeof p.linger === 'boolean').toBe(true);
  });

  it.skipIf(process.arch !== 'x64')('reports arch x64 on an x64 host', () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    const p = parseProbe(
      runSh(probeCommand('sh'), { env: { PATH: process.env.PATH, HOME: home } }).stdout,
    );
    expect(p).toMatchObject({ arch: 'x64' });
  });

  it('reads installed version dirs and skips .tmp dirs and conduit-hc', () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    plant(home);
    const p = parseProbe(
      runSh(probeCommand('sh'), { env: { PATH: process.env.PATH, HOME: home } }).stdout,
    );
    expect(p).toMatchObject({ installed: ['1.0.0'] });
  });

  it('reads a planted server-version as recorded', () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    plant(home);
    const p = parseProbe(
      runSh(probeCommand('sh'), { env: { PATH: process.env.PATH, HOME: home } }).stdout,
    );
    expect(p).toMatchObject({ recorded: { version: '1.0.0', linkMajor: 1 } });
  });

  it('reports recorded null and installed [] on an empty home', () => {
    const home = join(dir, 'empty');
    mkdirSync(home);
    const p = parseProbe(
      runSh(probeCommand('sh'), { env: { PATH: process.env.PATH, HOME: home } }).stdout,
    );
    expect(p).toMatchObject({ recorded: null, installed: [] });
  });
});

describe('startMethodOf (decision 4, G7 rows)', () => {
  // linger, systemd-run present, KillUserProcesses -> method, survivesLogout
  const rows: [boolean | null, boolean, boolean | null, string, boolean][] = [
    [true, true, true, 'scope', true],
    [true, true, false, 'scope', true],
    [true, true, null, 'scope', true],
    [true, false, true, 'plain', false],
    [true, false, false, 'plain', true],
    [true, false, null, 'plain', false],
    [false, true, true, 'plain', false],
    [false, true, false, 'plain', true],
    [false, true, null, 'plain', false],
    [false, false, true, 'plain', false],
    [false, false, false, 'plain', true],
    [false, false, null, 'plain', false],
    [null, true, true, 'plain', false],
    [null, true, false, 'plain', true],
    [null, true, null, 'plain', false],
    [null, false, true, 'plain', false],
    [null, false, false, 'plain', true],
    [null, false, null, 'plain', false],
  ];

  function linuxProbe(
    linger: boolean | null,
    systemdRun: boolean,
    kup: boolean | null,
  ): ProbeResult {
    return {
      os: 'linux',
      arch: 'x64',
      home: '/h',
      userData: '/h/.config/conduit',
      freeBytes: null,
      kup,
      linger,
      systemdRun,
      installed: [],
      recorded: null,
      agents: [],
    };
  }

  it.each(rows)(
    'linger=%s systemd-run=%s kup=%s -> %s, survives=%s',
    (linger, systemdRun, kup, method, survives) => {
      expect(startMethodOf(linuxProbe(linger, systemdRun, kup))).toEqual({
        method,
        survivesLogout: survives,
      });
    },
  );

  it('uses windows-task, which never survives logout, on a Windows remote', () => {
    expect(startMethodOf({ ...linuxProbe(null, false, null), os: 'windows', arch: 'x64' })).toEqual(
      { method: 'windows-task', survivesLogout: false },
    );
  });
});

describe.skipIf(!posix || !hasSh())('download (sh)', () => {
  const stagingOf = (): string => join(dir, 'stage');

  function fileOf(content: string, name = 'src.bin'): { path: string; digest: string } {
    const path = join(dir, name);
    writeFileSync(path, content);
    return { path, digest: sha(content) };
  }

  it.skipIf(!hasCurl)(
    'fetches a file:// pin with curl, verifies sha256 and writes the dest',
    () => {
      const src = fileOf('node-bytes');
      const pin: PinFile = { url: `file://${src.path}`, sha256: src.digest, dest: 'node' };
      const r = runSh(downloadCommand('sh', { stagingDir: stagingOf(), pins: [pin] }));
      expect(parseResultLine(r.stdout)).toEqual({ ok: true });
      expect(readFileSync(join(stagingOf(), 'node'), 'utf8')).toBe('node-bytes');
      expect(statSync(join(stagingOf(), 'node')).mode & 0o111).not.toBe(0);
    },
  );

  it('copies a local-path pin when allowLocal is set (test-only)', () => {
    const src = fileOf('local-bytes');
    const pin: PinFile = { url: src.path, sha256: src.digest, dest: 'node' };
    const r = runSh(
      downloadCommand('sh', { stagingDir: stagingOf(), pins: [pin], allowLocal: true }),
    );
    expect(parseResultLine(r.stdout)).toEqual({ ok: true });
    expect(readFileSync(join(stagingOf(), 'node'), 'utf8')).toBe('local-bytes');
  });

  it('refuses a bare-path pin when allowLocal is not set, as the bootstrap does', () => {
    const src = fileOf('local-bytes');
    const pin: PinFile = { url: src.path, sha256: src.digest, dest: 'node' };
    const r = runSh(downloadCommand('sh', { stagingDir: stagingOf(), pins: [pin] }));
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'download' });
    expect(existsSync(stagingOf())).toBe(false);
  });

  it('a checksum mismatch returns checksum and removes the staging folder', () => {
    const src = fileOf('bytes');
    const pin: PinFile = { url: src.path, sha256: sha('other'), dest: 'node' };
    const r = runSh(
      downloadCommand('sh', { stagingDir: stagingOf(), pins: [pin], allowLocal: true }),
    );
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'checksum' });
    expect(existsSync(stagingOf())).toBe(false);
  });

  it('extracts an archive pin, applies its rename, and lands the dest file', () => {
    const tree = join(dir, 'tree', 'pkg', 'bin');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'herdr-core'), 'hc-bytes');
    const archive = join(dir, 'hc.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', join(dir, 'tree'), 'pkg']);
    const pin: PinFile = {
      url: archive,
      sha256: sha(readFileSync(archive)),
      dest: 'conduit-hc',
      archive: 'tar.gz',
      stripComponents: 1,
      rename: { 'bin/herdr-core': 'conduit-hc' },
    };
    const r = runSh(
      downloadCommand('sh', { stagingDir: stagingOf(), pins: [pin], allowLocal: true }),
    );
    expect(parseResultLine(r.stdout)).toEqual({ ok: true });
    expect(readFileSync(join(stagingOf(), 'conduit-hc'), 'utf8')).toBe('hc-bytes');
  });

  it('refuses an unsafe dest with a download failure and no staging folder', () => {
    const src = fileOf('bytes');
    const pin: PinFile = { url: src.path, sha256: src.digest, dest: '../escape' };
    const r = runSh(
      downloadCommand('sh', { stagingDir: stagingOf(), pins: [pin], allowLocal: true }),
    );
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'download' });
    expect(existsSync(join(dir, 'escape'))).toBe(false);
  });
});

describe.skipIf(!posix || !hasSh())('receiveFile (sh)', () => {
  it('writes stdin to the path when size and sha256 match', () => {
    const path = join(dir, 'out', 'node');
    const data = Buffer.from('pushed-node');
    const r = runSh(receiveFileCommand('sh', { path, sha256: sha(data), size: data.length }), {
      input: data,
    });
    expect(parseResultLine(r.stdout)).toEqual({ ok: true });
    expect(readFileSync(path).equals(data)).toBe(true);
  });

  it('a wrong sha256 returns checksum and leaves no file behind', () => {
    const path = join(dir, 'node');
    const data = Buffer.from('pushed-node');
    const r = runSh(receiveFileCommand('sh', { path, sha256: sha('other'), size: data.length }), {
      input: data,
    });
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'checksum' });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
  });
});

describe.skipIf(!posix || !hasSh())('receiveTree (sh)', () => {
  /** A source tree, its manifest, and a tar stream of it made by the system tar. */
  function sourceTree(files: Record<string, string>): {
    manifest: ManifestEntry[];
    tar: Buffer;
  } {
    const src = join(dir, 'src');
    const manifest: ManifestEntry[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(src, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
      manifest.push({ path: rel, sha256: sha(content), size: Buffer.byteLength(content) });
    }
    const tar = execFileSync('tar', ['-cf', '-', '-C', src, '.']);
    return { manifest, tar };
  }

  it('unpacks the stream and verifies every file against the manifest', () => {
    const { manifest, tar } = sourceTree({ 'main.js': 'console.log(1)', 'lib/a.js': 'a' });
    const dest = join(dir, 'server');
    const r = runSh(receiveTreeCommand('sh', { dir: dest, manifest }), { input: tar });
    expect(parseResultLine(r.stdout)).toEqual({ ok: true });
    expect(readFileSync(join(dest, 'lib', 'a.js'), 'utf8')).toBe('a');
  });

  it.each([
    ['a .. segment', '../evil.js'],
    ['an absolute path', '/etc/evil.js'],
    ['a backslash', 'lib\\evil.js'],
  ])('refuses a manifest path with %s before unpacking', (_label, bad) => {
    const { tar } = sourceTree({ 'main.js': 'x' });
    const dest = join(dir, 'server');
    const r = runSh(
      receiveTreeCommand('sh', {
        dir: dest,
        manifest: [{ path: bad, sha256: sha('x'), size: 1 }],
      }),
      { input: tar },
    );
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'unpack' });
    expect(existsSync(dest)).toBe(false);
  });

  it('rejects a file that the manifest does not list', () => {
    const { manifest, tar } = sourceTree({ 'main.js': 'x', 'extra.js': 'y' });
    const dest = join(dir, 'server');
    const r = runSh(
      receiveTreeCommand('sh', {
        dir: dest,
        manifest: manifest.filter((m) => m.path !== 'extra.js'),
      }),
      { input: tar },
    );
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'unpack' });
    expect(existsSync(dest)).toBe(false);
  });

  it('rejects a file whose sha256 does not match the manifest', () => {
    const { manifest, tar } = sourceTree({ 'main.js': 'x' });
    const dest = join(dir, 'server');
    const r = runSh(
      receiveTreeCommand('sh', {
        dir: dest,
        manifest: manifest.map((m) => ({ ...m, sha256: sha('tampered') })),
      }),
      { input: tar },
    );
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'checksum' });
    expect(existsSync(dest)).toBe(false);
  });
});

describe.skipIf(!posix || !hasSh())('finalize (sh)', () => {
  it('renames <version>.tmp to <version>', () => {
    mkdirSync(join(dir, '1.0.0.tmp'));
    writeFileSync(join(dir, '1.0.0.tmp', 'marker'), 'm');
    const r = runSh(finalizeCommand('sh', { runtimeRoot: dir, version: '1.0.0' }));
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, '1.0.0', 'marker'), 'utf8')).toBe('m');
    expect(existsSync(join(dir, '1.0.0.tmp'))).toBe(false);
  });

  it('when <version> already exists it removes the tmp and succeeds', () => {
    mkdirSync(join(dir, '1.0.0'));
    writeFileSync(join(dir, '1.0.0', 'kept'), 'k');
    mkdirSync(join(dir, '1.0.0.tmp'));
    const r = runSh(finalizeCommand('sh', { runtimeRoot: dir, version: '1.0.0' }));
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: true });
    expect(existsSync(join(dir, '1.0.0.tmp'))).toBe(false);
    expect(readFileSync(join(dir, '1.0.0', 'kept'), 'utf8')).toBe('k');
  });
});

describe.skipIf(!posix || !hasSh())('ensure and value passing (sh)', () => {
  it('execs node with exactly the decoded arguments', () => {
    const main = join(dir, 'echo-args.mjs');
    writeFileSync(main, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const r = runSh(
      ensureCommand('sh', {
        node: process.execPath,
        mainJs: main,
        userData: '/home/u/.config/conduit',
        method: 'scope',
      }),
    );
    const args = JSON.parse(r.stdout.trim());
    expect(args).toEqual([
      '--ensure-server',
      '--user-data',
      '/home/u/.config/conduit',
      '--start',
      'scope',
    ]);
  });

  it('values with quotes, $(), backticks, spaces and newlines round-trip as data', () => {
    const marker = join(dir, 'PWNED');
    const hostile = `a'b $(touch ${marker}) \`touch ${marker}\` c\nd`;
    const main = join(dir, 'echo-args.mjs');
    writeFileSync(main, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const r = runSh(
      ensureCommand('sh', {
        node: process.execPath,
        mainJs: main,
        userData: hostile,
        method: 'plain',
      }),
    );
    expect(JSON.parse(r.stdout.trim())[2]).toBe(hostile);
    expect(existsSync(marker)).toBe(false);

    const path = join(dir, `file ${hostile}`);
    const data = Buffer.from('bytes');
    const w = runSh(receiveFileCommand('sh', { path, sha256: sha(data), size: 5 }), {
      input: data,
    });
    expect(parseResultLine(w.stdout)).toEqual({ ok: true });
    expect(readFileSync(path).equals(data)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('PowerShell builders (output only; pwsh is not required)', () => {
  const families: ShellFamily[] = ['powershell', 'cmd'];

  it.each(families)('%s probe and every script use the -EncodedCommand form', (f) => {
    const prefix = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ';
    expect(probeCommand(f).command.startsWith(prefix)).toBe(true);
    expect(downloadCommand(f, { stagingDir: 'C:\\s', pins: [] }).command.startsWith(prefix)).toBe(
      true,
    );
    expect(
      receiveFileCommand(f, { path: 'C:\\x', sha256: 'a'.repeat(64), size: 1 }).command.startsWith(
        prefix,
      ),
    ).toBe(true);
    expect(receiveTreeCommand(f, { dir: 'C:\\s', manifest: [] }).command.startsWith(prefix)).toBe(
      true,
    );
    expect(
      finalizeCommand(f, { runtimeRoot: 'C:\\r', version: '1' }).command.startsWith(prefix),
    ).toBe(true);
    expect(
      ensureCommand(f, {
        node: 'C:\\n.exe',
        mainJs: 'C:\\m.js',
        userData: 'C:\\u',
        method: 'plain',
      }).command.startsWith(prefix),
    ).toBe(true);
  });

  it('a cmd.exe remote gets the same command as a PowerShell remote', () => {
    expect(probeCommand('cmd')).toEqual(probeCommand('powershell'));
  });

  it('carries the values as base64 in a $CONDUIT_ARGS prelude, never raw', () => {
    const hostile = "C:\\it's $(calc) `x`";
    const script = decodePs(
      receiveFileCommand('powershell', { path: hostile, sha256: 'a'.repeat(64), size: 1 }),
    );
    expect(script).toContain('$CONDUIT_ARGS = @(');
    expect(script).toContain(Buffer.from(hostile).toString('base64'));
    expect(script).not.toContain(hostile);
    expect(script).toContain('CONDUIT_RESULT');
  });

  it('the Windows-task start registers a logon-only task before ensure runs', () => {
    const script = decodePs(
      ensureCommand('powershell', {
        node: 'C:\\n.exe',
        mainJs: 'C:\\m.js',
        userData: 'C:\\u',
        method: 'windows-task',
      }),
    );
    expect(script).toContain('Register-ScheduledTask');
    expect(script).toContain('Interactive');
    expect(script).toContain('--ensure-server');
  });

  it('the plain start registers no task', () => {
    const script = decodePs(
      ensureCommand('powershell', {
        node: 'C:\\n.exe',
        mainJs: 'C:\\m.js',
        userData: 'C:\\u',
        method: 'plain',
      }),
    );
    expect(script).not.toContain('Register-ScheduledTask');
  });

  it.skipIf(!hasPwsh || process.platform !== 'win32')(
    'the probe runs under pwsh and reports a parseable result on Windows',
    () => {
      const cmd = probeCommand('powershell').command;
      const b64 = cmd.slice(cmd.indexOf('-EncodedCommand ') + '-EncodedCommand '.length);
      const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      const p = parseProbe(r.stdout);
      expect(p).not.toHaveProperty('error');
      expect(p).toMatchObject({ os: 'windows' });
    },
  );
});
