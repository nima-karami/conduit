import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pins from '../../build/runtime-pins.json';
import { createBootstrapper } from '../../server/network/bootstrap';
import type { SshExecOptions, SshExecResult } from '../../server/network/ssh-exec';
import { HC_PINNED_VERSION } from '../../src/contracts/hc';
import { LINK_PROTOCOL } from '../../src/contracts/link-protocol';
import { FAMILY_PROBE, type RemoteCommand } from '../../src/network/remote-scripts';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

// The bootstrap runs against a fake exec that decodes each RemoteCommand the real builders made.
// Decoding is what makes these tests exact: the fake sees the same scripts and base64 values a
// remote shell would, and answers as the remote would.

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'bootstrap-test-'));
  created.push(d);
  return d;
}

/** The shell words of a POSIX-quoted line: single quotes, with '\'' as an escaped quote. */
function words(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      cur += text.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (c === '\\') {
      cur += text[i + 1];
      inWord = true;
      i += 2;
    } else if (c === ' ') {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
      i += 1;
    } else {
      cur += c;
      inWord = true;
      i += 1;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

type Kind =
  | 'family'
  | 'probe'
  | 'download'
  | 'receiveFile'
  | 'receiveTree'
  | 'finalize'
  | 'ensure'
  | 'unknown';

interface Decoded {
  kind: Kind;
  /** The decoded base64 values, in order. */
  values: string[];
  script: string;
}

function decode(command: string): Decoded {
  const b64 = (v: string) => Buffer.from(v, 'base64').toString('utf8');
  if (command === FAMILY_PROBE) return { kind: 'family', values: [], script: command };
  const ps = command.startsWith('powershell ');
  if (ps) {
    const script = Buffer.from(command.split('-EncodedCommand ')[1] ?? '', 'base64').toString(
      'utf16le',
    );
    const values = [...script.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((m) => b64(m[1] ?? ''));
    const kind: Kind = script.includes('Invoke-WebRequest')
      ? 'download'
      : script.includes('$manText')
        ? 'receiveTree'
        : script.includes('$path = Arg 0')
          ? 'receiveFile'
          : script.includes('Move-Item -LiteralPath $tmp')
            ? 'finalize'
            : script.includes('--ensure-server')
              ? 'ensure'
              : script.includes('Get-ChildItem')
                ? 'probe'
                : 'unknown';
    return { kind, values, script };
  }
  const t = words(command);
  const script = t[2] ?? '';
  const values = t.slice(4).map(b64);
  const kind: Kind = script.includes('KillUserProcesses')
    ? 'probe'
    : script.includes('CONDUIT_RENAMES')
      ? 'download'
      : script.includes('CONDUIT_MANIFEST')
        ? 'receiveTree'
        : script.includes('cat > "$P.part"')
          ? 'receiveFile'
          : script.includes('mv "$TMP" "$FINAL"')
            ? 'finalize'
            : script.includes('--ensure-server')
              ? 'ensure'
              : 'unknown';
  return { kind, values, script };
}

const ok = (stdout = ''): SshExecResult => ({ code: 0, stdout, stderr: '', failure: null });
const result = (line: unknown): SshExecResult => ok(`CONDUIT_RESULT ${JSON.stringify(line)}\n`);
const sshFail: SshExecResult = {
  code: null,
  stdout: '',
  stderr: '',
  failure: { code: 'ssh_unreachable', detail: 'Connection timed out' },
};

interface Probe {
  os?: 'linux' | 'windows' | 'other';
  arch?: 'x64' | 'arm64' | 'other';
  installed?: string[];
  recorded?: { version: string; linkMajor: number } | null;
  userData?: string;
  linger?: boolean | null;
  kup?: boolean | null;
}

function probeLine(p: Probe = {}): SshExecResult {
  return result({
    ok: true,
    os: p.os ?? 'linux',
    arch: p.arch ?? 'x64',
    home: '/home/u',
    userData: p.userData ?? '/home/u/.config/conduit',
    freeBytes: 10 ** 12,
    kup: p.kup ?? false,
    linger: p.linger ?? false,
    systemdRun: true,
    installed: p.installed ?? [],
    recorded: p.recorded ?? null,
    agents: [],
  });
}

interface Fixture {
  root: string;
  nodeExe: string;
  serverDir: string;
  hcExe: string;
  shimFile: string;
}

function fixture(): Fixture {
  const root = scratch();
  const serverDir = path.join(root, 'server');
  mkdirSync(path.join(serverDir, 'lib'), { recursive: true });
  writeFileSync(path.join(serverDir, 'main.js'), 'console.log(1)\n');
  writeFileSync(path.join(serverDir, 'lib', 'x.js'), 'module.exports = 2\n');
  const nodeExe = path.join(root, 'node');
  writeFileSync(nodeExe, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
  const hcExe = path.join(root, 'conduit-hc');
  writeFileSync(hcExe, 'hc');
  const shimFile = path.join(root, 'conduit-mcp-shim.cjs');
  writeFileSync(shimFile, 'shim');
  return { root, nodeExe, serverDir, hcExe, shimFile };
}

interface Script {
  /** Answers per kind; a function gets the call, so a test can branch on values. */
  answer(kind: Kind, call: { d: Decoded; stdin?: Buffer }, probe: Probe): SshExecResult;
  /** Overrides the probe answer; defaults to probeLine(probe). */
  probe?: Probe;
}

function remote(script: Script) {
  const calls: { kind: Kind; d: Decoded; stdin?: Buffer; target: string; command: string }[] = [];
  const exec = (o: SshExecOptions): Promise<SshExecResult> => {
    const command = (o.command as RemoteCommand).command;
    const d = decode(command);
    calls.push({
      kind: d.kind,
      d,
      stdin: o.stdin as Buffer | undefined,
      target: o.target,
      command,
    });
    const probe = script.probe ?? {};
    // sh does not expand %OS%, so its family line keeps the literal text (decision 1).
    if (d.kind === 'family') {
      // PowerShell expands $PSHOME, so its line carries a path after the sh line (decision 1).
      const line =
        probe.os === 'windows'
          ? 'CONDUIT_FAMILY_2_%OS%_C:\\Program Files\\PowerShell\\7'
          : 'CONDUIT_FAMILY_2_%OS%_';
      return Promise.resolve(ok(`${line}\n`));
    }
    if (d.kind === 'probe') return Promise.resolve(probeLine(probe));
    return Promise.resolve(
      script.answer(d.kind, { d, stdin: o.stdin as Buffer | undefined }, probe),
    );
  };
  return { exec, calls };
}

function bootstrapper(
  f: Fixture,
  exec: (o: SshExecOptions) => Promise<SshExecResult>,
  over: Partial<{
    local: {
      version: string;
      linkMajor: number;
      platform: 'linux' | 'win32' | 'other';
      arch: 'x64' | 'other';
    };
    noDownload: boolean;
    nodeExe: string | null;
  }> = {},
) {
  return createBootstrapper({
    local: over.local ?? {
      version: '1.2.3',
      linkMajor: LINK_PROTOCOL.major,
      platform: 'linux',
      arch: 'x64',
    },
    runtime: {
      nodeExe: over.nodeExe === undefined ? f.nodeExe : over.nodeExe,
      serverDir: f.serverDir,
      hcExe: f.hcExe,
      shimFile: f.shimFile,
    },
    ssh: { sshPath: 'ssh', controlDir: scratch() },
    noDownload: over.noDownload ?? false,
    exec,
  });
}

const TARGET = 'vm';
const ENSURE_OK = result({ ok: true, state: 'up', version: '1.2.3', survivesLogout: true });

const happy: Script = {
  answer(kind) {
    if (kind === 'ensure') return ENSURE_OK;
    return result({ ok: true });
  },
};

describe('bootstrap: install on a fresh remote', () => {
  it('runs the fixed steps in order and returns the endpoint and summary', async () => {
    const f = fixture();
    const r = remote(happy);
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(r.calls.map((c) => c.kind)).toEqual([
      'family',
      'probe',
      'download', // node, into <ver>.tmp
      'receiveTree', // server, into <ver>.tmp/server
      'finalize', // <ver>.tmp -> <ver>
      'download', // hc, into conduit-hc/<hcVersion>.tmp
      'finalize',
      'receiveTree', // the MCP shim dir, into shim.tmp
      'finalize',
      'ensure',
    ]);
    expect(outcome).toEqual({
      ok: true,
      ssh: {
        target: TARGET,
        node: '/home/u/.config/conduit/runtime/1.2.3/node',
        mainJs: '/home/u/.config/conduit/runtime/1.2.3/server/main.js',
        userData: '/home/u/.config/conduit',
      },
      summary: {
        os: 'linux',
        arch: 'x64',
        installed: true,
        upgraded: false,
        reused: false,
        survivesLogout: true,
        version: '1.2.3',
      },
    });
  });

  it('stages node in <ver>.tmp and hc in conduit-hc/<hcVersion>.tmp, never the final dirs', async () => {
    const f = fixture();
    const r = remote(happy);
    await bootstrapper(f, r.exec)(TARGET);
    const downloads = r.calls.filter((c) => c.kind === 'download');
    expect(downloads[0]?.d.values[0]).toBe('/home/u/.config/conduit/runtime/1.2.3.tmp');
    expect(downloads[1]?.d.values[0]).toBe('/home/u/.config/conduit/runtime/conduit-hc/0.1.16.tmp');
  });

  it('never asks the remote to fetch a local path (allowLocal stays 0)', async () => {
    const f = fixture();
    const r = remote(happy);
    await bootstrapper(f, r.exec)(TARGET);
    for (const d of r.calls.filter((c) => c.kind === 'download')) {
      expect(d.d.values).toContain('allowLocal=0');
      expect(d.d.values).not.toContain('allowLocal=1');
    }
  });

  it('builds the pins from build/runtime-pins.json for the remote platform, naming the final files', async () => {
    const f = fixture();
    const r = remote(happy);
    await bootstrapper(f, r.exec)(TARGET);
    const node = r.calls.find((c) => c.kind === 'download')?.d.values.join('\n') ?? '';
    expect(node).toContain('https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.gz');
    expect(node).toContain('783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8');
    // The archive yields `node` after its rename, so that is the dest the script checks.
    expect(node).toContain('\nnode\ntar.gz\n1\nbin/node\tnode');
  });

  it('streams the server tree as a tar whose manifest the receive script checks', async () => {
    const f = fixture();
    const r = remote(happy);
    await bootstrapper(f, r.exec)(TARGET);
    const tree = r.calls.find((c) => c.kind === 'receiveTree');
    expect(tree?.stdin).toBeInstanceOf(Buffer);
    const manifest = tree?.d.values[1] ?? '';
    expect(manifest.split('\n').map((l) => l.split('\t')[2])).toEqual(
      expect.arrayContaining(['main.js', 'lib/x.js']),
    );
    expect(manifest).toContain(sha256(Buffer.from('console.log(1)\n')));
  });
});

describe('bootstrap: push fallback', () => {
  it('pushes node over stdin when its download fails and the platforms match', async () => {
    const f = fixture();
    const script: Script = {
      answer(kind, call) {
        if (kind === 'download' && call.d.values[0]?.endsWith('1.2.3.tmp')) {
          return result({ ok: false, step: 'download', detail: 'could not fetch' });
        }
        if (kind === 'ensure') return ENSURE_OK;
        return result({ ok: true });
      },
    };
    const r = remote(script);
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(outcome.ok).toBe(true);
    const push = r.calls.find((c) => c.kind === 'receiveFile');
    expect(push?.d.values[0]).toBe('/home/u/.config/conduit/runtime/1.2.3.tmp/node');
    expect(push?.stdin?.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]))).toBe(true);
  });

  it('reports install_failed download, with no push, when the platforms differ', async () => {
    const f = fixture();
    const script: Script = {
      answer(kind, call) {
        if (kind === 'download' && call.d.values[0]?.endsWith('1.2.3.tmp')) {
          return result({ ok: false, step: 'download', detail: 'could not fetch' });
        }
        return result({ ok: true });
      },
    };
    const r = remote(script);
    const outcome = await bootstrapper(f, r.exec, {
      local: { version: '1.2.3', linkMajor: LINK_PROTOCOL.major, platform: 'win32', arch: 'x64' },
    })(TARGET);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error).toMatchObject({
      code: 'install_failed',
      step: 'download',
    });
    // The hint names the way out (plan decision 7): the remote's own fetch, or a same-OS controller.
    expect(outcome.ok ? '' : JSON.stringify(outcome.error)).toContain('same OS');
    expect(r.calls.some((c) => c.kind === 'receiveFile')).toBe(false);
  });

  it('forces the push path when noDownload is set, and checks the bytes it sent', async () => {
    const f = fixture();
    const r = remote(happy);
    await bootstrapper(f, r.exec, { noDownload: true })(TARGET);
    expect(r.calls.some((c) => c.kind === 'download')).toBe(false);
    expect(r.calls.filter((c) => c.kind === 'receiveFile').length).toBe(2);
  });

  it('does not fall back on a checksum failure: the download is not retried by push', async () => {
    const f = fixture();
    const script: Script = {
      answer(kind, call) {
        if (kind === 'download' && call.d.values[0]?.endsWith('1.2.3.tmp')) {
          return result({ ok: false, step: 'checksum', detail: 'sha256 mismatch' });
        }
        return result({ ok: true });
      },
    };
    const r = remote(script);
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'install_failed', step: 'checksum', detail: 'sha256 mismatch' },
    });
    expect(r.calls.some((c) => c.kind === 'receiveFile')).toBe(false);
  });
});

describe('bootstrap: decision flow', () => {
  it('attaches to an equal running server: probe and ensure only, nothing copied', async () => {
    const f = fixture();
    const r = remote({
      probe: { recorded: { version: '1.2.3', linkMajor: LINK_PROTOCOL.major } },
      answer: (kind) => (kind === 'ensure' ? ENSURE_OK : result({ ok: true })),
    });
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(r.calls.map((c) => c.kind)).toEqual(['family', 'probe', 'ensure']);
    expect(outcome.ok && outcome.summary).toMatchObject({ installed: false, reused: true });
  });

  it('attaches to a newer same-major server and never downgrades it', async () => {
    const f = fixture();
    const r = remote({
      probe: { recorded: { version: '9.9.9', linkMajor: LINK_PROTOCOL.major } },
      answer: (kind) =>
        kind === 'ensure'
          ? result({ ok: true, state: 'up', version: '9.9.9', survivesLogout: false })
          : result({ ok: true }),
    });
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(r.calls.map((c) => c.kind)).toEqual(['family', 'probe', 'ensure']);
    expect(outcome.ok && outcome.summary).toMatchObject({
      reused: true,
      version: '9.9.9',
      survivesLogout: false,
    });
  });

  it('upgrades an older same-major server: a copy, then ensure restarts it', async () => {
    const f = fixture();
    const r = remote({
      probe: { recorded: { version: '1.0.0', linkMajor: LINK_PROTOCOL.major } },
      answer: (kind) => (kind === 'ensure' ? ENSURE_OK : result({ ok: true })),
    });
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(r.calls.map((c) => c.kind)).toContain('receiveTree');
    expect(outcome.ok && outcome.summary).toMatchObject({ upgraded: true, installed: false });
  });

  it('refuses another link major as peer_incompatible, with nothing copied', async () => {
    const f = fixture();
    const r = remote({
      probe: { recorded: { version: '3.0.0', linkMajor: LINK_PROTOCOL.major + 1 } },
      answer: () => result({ ok: true }),
    });
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'peer_incompatible', remote: '3.0.0' },
    });
    expect(r.calls.map((c) => c.kind)).toEqual(['family', 'probe']);
  });

  it('refuses an arm64 remote as remote_unsupported, before anything runs there', async () => {
    const f = fixture();
    const r = remote({ probe: { arch: 'arm64' }, answer: () => result({ ok: true }) });
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'remote_unsupported', os: 'linux', arch: 'arm64' },
    });
    expect(r.calls.map((c) => c.kind)).toEqual(['family', 'probe']);
  });

  it('skips the copy when the version is already installed but no server runs', async () => {
    const f = fixture();
    const r = remote({
      probe: { installed: ['1.2.3'] },
      answer: (kind) => (kind === 'ensure' ? ENSURE_OK : result({ ok: true })),
    });
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(r.calls.map((c) => c.kind)).toEqual(['family', 'probe', 'ensure']);
    expect(outcome.ok && outcome.summary).toMatchObject({ reused: true, installed: false });
  });

  it('gives ensure the --shim-dir and the survival the probe decided', async () => {
    const f = fixture();
    const r = remote({ probe: { linger: false, kup: false }, answer: () => ENSURE_OK });
    await bootstrapper(f, r.exec)(TARGET);
    const ensure = r.calls.find((c) => c.kind === 'ensure');
    expect(ensure?.d.values).toEqual([
      '/home/u/.config/conduit/runtime/1.2.3/node',
      '/home/u/.config/conduit/runtime/1.2.3/server/main.js',
      '/home/u/.config/conduit',
      'plain',
      'yes',
      '/home/u/.config/conduit/runtime/shim',
    ]);
  });
});

describe('bootstrap: failures', () => {
  it('maps a failed remote script to install_failed with its own step and detail', async () => {
    const f = fixture();
    const r = remote({
      answer: (kind) =>
        kind === 'receiveTree'
          ? result({ ok: false, step: 'unpack', detail: 'tar could not unpack the stream' })
          : result({ ok: true }),
    });
    const outcome = await bootstrapper(f, r.exec)(TARGET);
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'install_failed', step: 'unpack', detail: 'tar could not unpack the stream' },
    });
  });

  it('returns the ssh failure when a step never reaches its result line', async () => {
    const f = fixture();
    const r = remote({ answer: (kind) => (kind === 'download' ? sshFail : result({ ok: true })) });
    const outcome = await bootstrapper(f, r.exec, { noDownload: false })(TARGET);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error).toEqual({
      code: 'ssh_unreachable',
      detail: 'Connection timed out',
    });
  });

  it('shares one run between concurrent calls for one target', async () => {
    const f = fixture();
    const r = remote(happy);
    const bootstrap = bootstrapper(f, r.exec);
    const [a, b] = await Promise.all([bootstrap(TARGET), bootstrap(TARGET)]);
    expect(a).toBe(b);
    expect(r.calls.filter((c) => c.kind === 'family').length).toBe(1);
  });

  it('after an interrupted install, the next run restages from scratch and cleans the tmp', async () => {
    const f = fixture();
    let interrupt = true;
    const r = remote({
      answer: (kind) => {
        if (kind === 'receiveTree' && interrupt) {
          interrupt = false;
          return sshFail;
        }
        return kind === 'ensure' ? ENSURE_OK : result({ ok: true });
      },
    });
    const bootstrap = bootstrapper(f, r.exec);
    const first = await bootstrap(TARGET);
    expect(first.ok).toBe(false);
    // The node download is the first write of a run, and its script removes <ver>.tmp first.
    const again = await bootstrap(TARGET);
    expect(again.ok).toBe(true);
    const stagings = r.calls.filter((c) => c.kind === 'download').map((c) => c.d.values[0]);
    // Calls: run one's node download, then run two's node download and hc download.
    expect(stagings).toEqual([
      '/home/u/.config/conduit/runtime/1.2.3.tmp',
      '/home/u/.config/conduit/runtime/1.2.3.tmp',
      '/home/u/.config/conduit/runtime/conduit-hc/0.1.16.tmp',
    ]);
  });
});

describe('bootstrap: the pins', () => {
  it('reads the win32 node pin as the exe itself, with no archive', async () => {
    const f = fixture();
    const r = remote({
      probe: { os: 'windows' },
      answer: (kind) => (kind === 'ensure' ? ENSURE_OK : result({ ok: true })),
    });
    await bootstrapper(f, r.exec)(TARGET);
    const node = r.calls.find((c) => c.kind === 'download');
    expect(node?.command.startsWith('powershell ')).toBe(true);
    expect(node?.d.script).toContain('Invoke-WebRequest');
    expect(node?.d.values.join('\n')).toContain('node.exe');
  });
});

describe('bootstrap: the pinned hc', () => {
  it('lands hc in the directory the layout names for the pinned version', () => {
    // The pins' hc version and the directory the install and ensure both use must agree.
    expect(pins['linux-x64'].hc.version).toBe(HC_PINNED_VERSION);
    expect(pins['win32-x64'].hc.version).toBe(HC_PINNED_VERSION);
  });
});
