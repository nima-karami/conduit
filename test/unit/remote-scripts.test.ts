import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

/** A directory holding one fake executable per name, to run first on PATH. */
function fakeBin(name: string, body: string): string {
  const bin = mkdtempSync(join(dir, 'fake-'));
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return bin;
}

describe.skipIf(!posix || !hasSh())(
  'sh probe: musl, kup/linger, free space, .gc (fakes on PATH)',
  () => {
    function probeWith(home: string, fakes: string[]): ReturnType<typeof parseProbe> {
      mkdirSync(home, { recursive: true });
      const path = [...fakes, process.env.PATH ?? ''].join(':');
      return parseProbe(runSh(probeCommand('sh'), { env: { PATH: path, HOME: home } }).stdout);
    }

    it('reports os other for a musl libc, so planInstall refuses it (spec §6)', () => {
      const ldd = fakeBin('ldd', 'echo "musl libc (x86_64)" >&2');
      const p = probeWith(join(dir, 'h1'), [ldd]);
      expect(p).toMatchObject({ os: 'other' });
    });

    it('reports os linux for a glibc ldd', () => {
      const ldd = fakeBin('ldd', 'echo "ldd (GNU libc) 2.39"');
      const p = probeWith(join(dir, 'h2'), [ldd]);
      expect(p).toMatchObject({ os: 'linux' });
    });

    it.each([
      ['b true', true],
      ['b false', false],
      ['garbage', null],
    ])('parses busctl KillUserProcesses %s as kup %s', (out, kup) => {
      const busctl = fakeBin('busctl', `echo "${out}"`);
      expect(probeWith(join(dir, 'k'), [busctl])).toMatchObject({ kup });
    });

    it.each([
      ['yes', true],
      ['no', false],
      ['', null],
    ])('parses loginctl Linger %j as linger %s', (out, linger) => {
      const loginctl = fakeBin('loginctl', `echo "${out}"`);
      expect(probeWith(join(dir, 'l'), [loginctl])).toMatchObject({ linger });
    });

    it('excludes .gc and .tmp runtime leftovers from installed', () => {
      const home = join(dir, 'g');
      const runtime = join(home, '.config', 'conduit', 'runtime');
      for (const name of ['1.2.3', '1.2.2.gc', '1.2.4.tmp', 'shim'])
        mkdirSync(join(runtime, name), { recursive: true });
      expect(probeWith(home, [])).toMatchObject({ installed: ['1.2.3'] });
    });
  },
);

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
  const stagingOf = (): string => join(dir, 'stage.tmp');

  function fileOf(content: string, name = 'src.bin'): { path: string; digest: string } {
    const path = join(dir, name);
    writeFileSync(path, content);
    return { path, digest: sha(content) };
  }

  it('refuses a pin that is not https, even with a local file present and no allowLocal', () => {
    const src = fileOf('node-bytes');
    for (const url of [`file://${src.path}`, 'http://example.invalid/node']) {
      const pin: PinFile = { url, sha256: src.digest, dest: 'node' };
      const r = runSh(downloadCommand('sh', { stagingDir: stagingOf(), pins: [pin] }));
      expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'download' });
      expect(existsSync(stagingOf())).toBe(false);
    }
  });

  it('refuses a pin URL that starts with -, which curl would read as an option, even under allowLocal', () => {
    const cfg = join(dir, 'cfg');
    writeFileSync(cfg, 'x');
    const src = fileOf('bytes');
    const pin: PinFile = { url: `-K${cfg}`, sha256: src.digest, dest: 'node' };
    const r = runSh(
      downloadCommand('sh', { stagingDir: stagingOf(), pins: [pin], allowLocal: true }),
    );
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'download' });
  });

  it('refuses a staging dir that is not under a .tmp folder, and leaves its files alone', () => {
    const notTmp = join(dir, 'stage');
    mkdirSync(notTmp);
    writeFileSync(join(notTmp, 'keep'), 'k');
    const src = fileOf('bytes');
    const pin: PinFile = { url: src.path, sha256: src.digest, dest: 'node' };
    const r = runSh(downloadCommand('sh', { stagingDir: notTmp, pins: [pin], allowLocal: true }));
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'download' });
    expect(readFileSync(join(notTmp, 'keep'), 'utf8')).toBe('k');
  });

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
    const path = join(dir, 'out.tmp', 'node');
    const data = Buffer.from('pushed-node');
    const r = runSh(receiveFileCommand('sh', { path, sha256: sha(data), size: data.length }), {
      input: data,
    });
    expect(parseResultLine(r.stdout)).toEqual({ ok: true });
    expect(readFileSync(path).equals(data)).toBe(true);
  });

  it('a wrong sha256 returns checksum and leaves no file behind', () => {
    const path = join(dir, 'n.tmp', 'node');
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
    const dest = join(dir, 'v.tmp', 'server');
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
    const dest = join(dir, 'v.tmp', 'server');
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
    const dest = join(dir, 'v.tmp', 'server');
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
    const dest = join(dir, 'v.tmp', 'server');
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

/** One raw ustar entry, hand-built so the test controls the typeflag (tar-pack writes only files). */
function rawEntry(name: string, typeflag: string, linkname = '', body = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(typeflag, 156, 'ascii');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return Buffer.concat([h, Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)])]);
}

describe.skipIf(!posix || !hasSh())('receiveTree refuses links and special files', () => {
  const good = Buffer.from('good');
  const manifest = [{ path: 'main.js', sha256: sha(good), size: good.length }];
  const end = Buffer.alloc(1024);

  it('refuses a symlink the manifest does not list, and removes the dir', () => {
    // find -type f skips a symlink, so only the "not ! -type d ! -type f" check catches it.
    const tar = Buffer.concat([
      rawEntry('main.js', '0', '', good),
      rawEntry('link', '2', '/etc/passwd'),
      end,
    ]);
    const dest = join(dir, 'v.tmp', 'server');
    const r = runSh(receiveTreeCommand('sh', { dir: dest, manifest }), { input: tar });
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'unpack' });
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a hardlink, and removes the dir', () => {
    const tar = Buffer.concat([
      rawEntry('main.js', '0', '', good),
      rawEntry('hl', '1', 'main.js'),
      end,
    ]);
    const dest = join(dir, 'v.tmp', 'server');
    const r = runSh(receiveTreeCommand('sh', { dir: dest, manifest }), { input: tar });
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'unpack' });
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a listed path that arrives as a symlink', () => {
    const tar = Buffer.concat([rawEntry('main.js', '2', '/etc/passwd'), end]);
    const dest = join(dir, 'v.tmp', 'server');
    const r = runSh(receiveTreeCommand('sh', { dir: dest, manifest }), { input: tar });
    expect(parseResultLine(r.stdout)).toMatchObject({ ok: false, step: 'unpack' });
    expect(existsSync(dest)).toBe(false);
  });
});

describe.skipIf(!posix || !hasSh())('no sha256 tool on PATH', () => {
  it('fails closed with its own detail, before writing anything', () => {
    // A PATH of the tools the scripts need, minus sha256sum and shasum.
    const bin = mkdtempSync(join(dir, 'nosha-'));
    for (const tool of [
      'sh',
      'base64',
      'cut',
      'tr',
      'sed',
      'grep',
      'mkdir',
      'rm',
      'mv',
      'cat',
      'wc',
      'chmod',
      'cp',
      'dirname',
      'find',
      'head',
      'awk',
      'df',
      'uname',
      'id',
      'basename',
    ]) {
      for (const from of ['/usr/bin', '/bin']) {
        if (existsSync(join(from, tool))) {
          symlinkSync(join(from, tool), join(bin, tool));
          break;
        }
      }
    }
    const data = Buffer.from('bytes');
    const path = join(dir, 'n.tmp', 'node');
    const r = runSh(receiveFileCommand('sh', { path, sha256: sha(data), size: data.length }), {
      input: data,
      env: { PATH: bin },
    });
    expect(parseResultLine(r.stdout)).toEqual({
      ok: false,
      step: 'checksum',
      detail: 'no_sha256_tool',
    });
    expect(existsSync(path)).toBe(false);
  });
});

describe.skipIf(!posix || !hasSh())('an interrupted run leaves a partial <v>.tmp', () => {
  /** A half-written staging folder: a wrong-hash node and a file nothing should have left there. */
  function plantPartial(tmp: string): void {
    mkdirSync(join(tmp, 'server'), { recursive: true });
    writeFileSync(join(tmp, 'node'), 'half-written');
    writeFileSync(join(tmp, 'extra.txt'), 'leftover');
    writeFileSync(join(tmp, 'server', 'main.js'), 'half');
    writeFileSync(join(tmp, 'server', 'extra.js'), 'leftover');
  }

  it('the next download replaces it, and finalize then succeeds', () => {
    const tmp = join(dir, '1.0.0.tmp');
    plantPartial(tmp);
    const src = join(dir, 'node-src');
    writeFileSync(src, 'fresh-node');
    const pin: PinFile = { url: src, sha256: sha('fresh-node'), dest: 'node' };
    const d = runSh(downloadCommand('sh', { stagingDir: tmp, pins: [pin], allowLocal: true }));
    expect(parseResultLine(d.stdout)).toEqual({ ok: true });
    expect(existsSync(join(tmp, 'extra.txt'))).toBe(false);
    expect(existsSync(join(tmp, 'server'))).toBe(false);
    expect(readFileSync(join(tmp, 'node'), 'utf8')).toBe('fresh-node');
    const f = runSh(finalizeCommand('sh', { runtimeRoot: dir, version: '1.0.0' }));
    expect(parseResultLine(f.stdout)).toMatchObject({ ok: true, existed: false });
    expect(readFileSync(join(dir, '1.0.0', 'node'), 'utf8')).toBe('fresh-node');
    expect(existsSync(tmp)).toBe(false);
  });

  it('the next receiveTree replaces a half-written server dir, and finalize succeeds', () => {
    const tmp = join(dir, '1.0.0.tmp');
    plantPartial(tmp);
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'main.js'), 'good');
    const tar = execFileSync('tar', ['-cf', '-', '-C', src, '.']);
    const manifest = [{ path: 'main.js', sha256: sha('good'), size: 4 }];
    const r = runSh(receiveTreeCommand('sh', { dir: join(tmp, 'server'), manifest }), {
      input: tar,
    });
    expect(parseResultLine(r.stdout)).toEqual({ ok: true });
    expect(existsSync(join(tmp, 'server', 'extra.js'))).toBe(false);
    expect(readFileSync(join(tmp, 'server', 'main.js'), 'utf8')).toBe('good');
    const f = runSh(finalizeCommand('sh', { runtimeRoot: dir, version: '1.0.0' }));
    expect(parseResultLine(f.stdout)).toMatchObject({ ok: true });
  });

  it('the next receiveFile replaces a half-written file, and finalize succeeds', () => {
    const tmp = join(dir, '1.0.0.tmp');
    plantPartial(tmp);
    const data = Buffer.from('pushed-node');
    const r = runSh(
      receiveFileCommand('sh', { path: join(tmp, 'node'), sha256: sha(data), size: data.length }),
      { input: data },
    );
    expect(parseResultLine(r.stdout)).toEqual({ ok: true });
    expect(readFileSync(join(tmp, 'node')).equals(data)).toBe(true);
    const f = runSh(finalizeCommand('sh', { runtimeRoot: dir, version: '1.0.0' }));
    expect(parseResultLine(f.stdout)).toMatchObject({ ok: true });
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
        survivesLogout: true,
      }),
    );
    const args = JSON.parse(r.stdout.trim());
    expect(args).toEqual([
      '--ensure-server',
      '--user-data',
      '/home/u/.config/conduit',
      '--start',
      'scope',
      '--survives-logout',
      'yes',
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
        survivesLogout: false,
      }),
    );
    expect(JSON.parse(r.stdout.trim())[2]).toBe(hostile);
    expect(existsSync(marker)).toBe(false);

    const path = join(dir, 'x.tmp', `file ${hostile}`);
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
        mainJs: 'C:\\m\\main.js',
        userData: 'C:\\u',
        survivesLogout: false,
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

  it('the Windows-task start registers a logon-only task that runs the supervisor', () => {
    const script = decodePs(
      ensureCommand('powershell', {
        node: 'C:\\n.exe',
        mainJs: 'C:\\rt\\1.0.0\\server\\main.js',
        userData: 'C:\\u',
        survivesLogout: false,
        method: 'windows-task',
        hcExe: 'C:\\rt\\conduit-hc\\0.1.16\\conduit-hc.exe',
      }),
    );
    expect(script).toContain('Register-ScheduledTask');
    expect(script).toContain('Interactive');
    expect(script).toContain('--ensure-server');
    // The action is the supervisor the app runs (esbuild's supervise entry), with the hc binary.
    expect(script).toContain('$sup = Arg 6');
    expect(script).toContain('$hc = Arg 7');
    expect(script).toContain('--hc');
    const values = [...script.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((m) =>
      Buffer.from(m[1], 'base64').toString('utf8'),
    );
    expect(values).toContain('C:\\rt\\1.0.0\\server\\supervise.js');
    expect(values).toContain('C:\\rt\\conduit-hc\\0.1.16\\conduit-hc.exe');
  });

  it('refuses a windows-task start without an hc executable, or a mainJs that is not main.js', () => {
    expect(() =>
      ensureCommand('powershell', {
        node: 'C:\\n.exe',
        mainJs: 'C:\\rt\\server\\main.js',
        userData: 'C:\\u',
        survivesLogout: false,
        method: 'windows-task',
      }),
    ).toThrow(/hc executable/);
    expect(() =>
      ensureCommand('powershell', {
        node: 'C:\\n.exe',
        mainJs: 'C:\\rt\\server\\other.js',
        userData: 'C:\\u',
        survivesLogout: false,
        method: 'plain',
      }),
    ).toThrow(/main\.js/);
  });

  it('the plain start registers no task', () => {
    const script = decodePs(
      ensureCommand('powershell', {
        node: 'C:\\n.exe',
        mainJs: 'C:\\m\\main.js',
        userData: 'C:\\u',
        survivesLogout: false,
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

describe('PowerShell scripts: automatic variables and argument quoting', () => {
  const pin: PinFile = { url: 'https://example.invalid/n', sha256: 'a'.repeat(64), dest: 'node' };
  const every = (): string[] =>
    [
      probeCommand('powershell'),
      downloadCommand('powershell', { stagingDir: 'C:\\x\\v.tmp', pins: [pin] }),
      receiveFileCommand('powershell', {
        path: 'C:\\x\\v.tmp\\node',
        sha256: 'a'.repeat(64),
        size: 1,
      }),
      receiveTreeCommand('powershell', { dir: 'C:\\x\\v.tmp\\server', manifest: [] }),
      finalizeCommand('powershell', { runtimeRoot: 'C:\\x', version: '1.0.0' }),
      ensureCommand('powershell', {
        node: 'C:\\n.exe',
        mainJs: 'C:\\x\\server\\main.js',
        userData: 'C:\\u',
        survivesLogout: false,
        method: 'windows-task',
        hcExe: 'C:\\h.exe',
      }),
      ensureCommand('powershell', {
        node: 'C:\\n.exe',
        mainJs: 'C:\\x\\server\\main.js',
        userData: 'C:\\u',
        survivesLogout: false,
        method: 'plain',
      }),
    ].map(decodePs);

  it('no PowerShell script assigns to an automatic variable', () => {
    // PowerShell names ignore case, so $Home = ... throws on every Windows remote (read-only $HOME).
    const automatic =
      /\$(home|args|input|error|host|pid|pwd|profile|true|false|null|_|matches|psitem|this|sender|event|eventargs|foreach|switch|pshome|ofs|lastexitcode|stacktrace|myinvocation|executioncontext|shellid|psboundparameters|psscriptroot|pscommandpath|consolefilename)\s*=(?!=)/i;
    for (const script of every()) expect(automatic.test(script)).toBe(false);
    // The pattern itself catches the assignment it was written for.
    expect(automatic.test('$home = $env:USERPROFILE')).toBe(true);
  });

  it('the scheduled-task argument is built by WinArg, never spliced', () => {
    const script = every()[5] ?? '';
    expect(script).toContain('function WinArg');
    expect(script).toContain('$argText = (WinArg $sup)');
    expect(script).not.toMatch(/'"' \+ \$sup/);
  });

  it('the PowerShell download refuses a strip count that is not digits', () => {
    expect(every()[1]).toContain("'^[0-9]+$'");
  });

  it.skipIf(!hasPwsh)('WinArg quotes each argument per the Windows argv rules', () => {
    const script = every()[5] ?? '';
    const start = script.indexOf('function WinArg');
    const fn = script.slice(start, script.indexOf('\n}', start) + 2);
    const run = `${fn}\n@(String.raw\`a b\`, String.raw\`C:\\dir\\\`, 'x"y', String.raw\`a\\"b\`) | ForEach-Object { Write-Output (WinArg $_) }`;
    const enc = Buffer.from(run, 'utf16le').toString('base64');
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.stdout.trim().split(/\r?\n/)).toEqual([
      String.raw`"a b"`,
      String.raw`"C:\dir\\"`,
      String.raw`"x\"y"`,
      String.raw`"a\\\"b"`,
    ]);
  });
});
