import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import pinsJson from '../../build/runtime-pins.json';
import { SHIM_LEAF } from '../../src/conduit-mcp/install-entries';
import { HC_PINNED_VERSION } from '../../src/contracts/hc';
import type { BootstrapResult, BootstrapSummary, SshEndpoint } from '../../src/contracts/ssh-link';
import { planInstall } from '../../src/network/install-plan';
import {
  copyNodeIntoShimCommand,
  downloadCommand,
  ensureCommand,
  FAMILY_PROBE,
  finalizeCommand,
  type PinFile,
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
import { manifestOf, packTree, type TreeFile } from '../../src/network/tar-pack';
import { runtimeBinaryName } from '../../src/runtime-binary';
import { CURRENT_SHIM_GENERATION, shimDirName } from '../runtime-dir/prepare';
import { sha256Of } from './sha256';
import type { SshExecOptions, SshExecResult } from './ssh-exec';

// The bootstrap is the controller's side of the install (spec 4.2.2-4.2.4, plan Architecture).
// Every remote step is a fixed script from remote-scripts.ts; nothing here builds a shell line.

/** A's own runtime, by path. The bootstrap only reads these; the server finds them at startup. */
export interface LocalRuntime {
  /** A's node binary, pushed when B cannot fetch its own. Null when this build has none. */
  nodeExe: string | null;
  /** A's server bundle: the directory that holds main.js. */
  serverDir: string;
  /** A's conduit-hc, pushed when B cannot fetch its own. */
  hcExe: string;
  /** A's MCP shim: the one file pushed into the shim dir (its node is copied on B). */
  shimFile: string;
}

/** One archive or file pin, as build/runtime-pins.json has it. */
export interface PinEntry {
  url: string;
  sha256: string;
  /** An archive pin's extracted binary; a push verifies against it (spec 5.5). Absent: no push. */
  binSha256?: string;
  archive?: string;
  stripComponents?: number;
  rename?: Record<string, string>;
}

export type PinKey = 'linux-x64' | 'win32-x64';
export type PinSet = Record<PinKey, { node: PinEntry; hc: PinEntry }>;

export interface BootstrapperOptions {
  local: {
    version: string;
    linkMajor: number;
    /** 'other' is any platform this build cannot push to; no remote is its match. */
    platform: 'linux' | 'win32' | 'other';
    arch: 'x64' | 'other';
  };
  runtime: LocalRuntime;
  ssh: Pick<SshExecOptions, 'sshPath' | 'sshArgsPrefix' | 'controlDir'>;
  /** CONDUIT_E2E_NO_DOWNLOAD (e2e only): skip the remote download and always push. */
  noDownload: boolean;
  /** The pins; the build's own by default. A test passes pins whose bytes it holds. */
  pins?: PinSet;
  exec: (o: SshExecOptions) => Promise<SshExecResult>;
}

export type BootstrapError = Extract<BootstrapResult, { ok: false }>['error'];
export type BootstrapOutcome =
  | { ok: true; ssh: SshEndpoint; summary: BootstrapSummary }
  | { ok: false; error: BootstrapError };

const PROBE_TIMEOUT_MS = 30_000;
const FINALIZE_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const TREE_TIMEOUT_MS = 10 * 60_000;
// The ensure step's own run is bounded at 90 s (ensure-server.ts); this bounds the ssh side.
const ENSURE_TIMEOUT_MS = 2 * 60_000;

// ── pins ─────────────────────────────────────────────────────────────────────

const DEFAULT_PINS: PinSet = pinsJson;

function archiveOf(name: string | undefined): PinFile['archive'] {
  if (name === undefined) return undefined;
  if (name === 'tar.gz' || name === 'zip') return name;
  throw new Error(`build/runtime-pins.json names an unknown archive: ${name}`);
}

/**
 * A pin in the form the remote scripts take. The dest is the file the install makes: for an
 * archive, the file the archive yields after its renames (remote-scripts.test.ts), which is the
 * layout's name for the binary (runtimeBinaryName).
 */
function pinOf(entry: PinEntry, dest: string): PinFile {
  const archive = archiveOf(entry.archive);
  return {
    url: entry.url,
    sha256: entry.sha256,
    dest,
    ...(archive ? { archive } : {}),
    ...(entry.stripComponents !== undefined ? { stripComponents: entry.stripComponents } : {}),
    ...(entry.rename ? { rename: entry.rename } : {}),
  };
}

/**
 * The sha256 a push must find, or null when the pin gives none. A file pin's sha256 is the file's
 * own. An archive pin's sha256 hashes the archive, so only its binSha256 names the binary, and a pin
 * without one is never pushed (fail closed, spec 5.5).
 */
function pushShaOf(entry: PinEntry): string | null {
  if (entry.archive === undefined) return entry.sha256;
  return entry.binSha256 ?? null;
}

// ── local files ──────────────────────────────────────────────────────────────

/** Every regular file under dir, `/`-separated and relative, with its permission bits. */
async function treeOf(dir: string, rel = ''): Promise<TreeFile[]> {
  const out: TreeFile[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
    const full = path.join(dir, relPath);
    if (entry.isDirectory()) {
      out.push(...(await treeOf(dir, relPath)));
    } else if (entry.isFile()) {
      const st = await stat(full);
      out.push({ path: relPath, data: await readFile(full), mode: st.mode & 0o777 });
    } else {
      throw new Error(`not a regular file, so it is not pushed: ${full}`);
    }
  }
  return out;
}

// ── one run ──────────────────────────────────────────────────────────────────

interface Ctx {
  family: ShellFamily;
  rp: typeof path.posix;
  runtimeRoot: string;
  hcRoot: string;
  pins: PinSet;
  noDownload: boolean;
  runtime: LocalRuntime;
  /** True when B is this build's own OS and arch, so A's binaries run there. */
  sameOs: boolean;
  os: 'linux' | 'windows';
  /** One remote script; its stdin is the value a push sends. */
  run(command: RemoteCommand, timeoutMs: number, stdin?: Buffer): Promise<SshExecResult>;
}

const fail = (error: BootstrapError): BootstrapOutcome => ({ ok: false, error });

/** A script's own failure is the step's; without a result line, the ssh failure is. */
function scriptError(
  r: SshExecResult,
  step: 'download' | 'unpack' | 'disk' | 'start',
): BootstrapError | null {
  const line = parseResultLine(r.stdout);
  if (line?.ok === true) return null;
  if (line?.ok === false) return { code: 'install_failed', step: line.step, detail: line.detail };
  if (r.failure !== null) return r.failure;
  return { code: 'install_failed', step, detail: 'the remote script printed no result' };
}

/**
 * Puts one binary at `placed`. The pinned download comes first. A failed download is pushed from A
 * only when A runs on B's own platform and the pin names the binary's sha256, which the push is
 * checked against on A and on B. Without that sha, the push is refused (fail closed).
 */
async function stageBinary(
  c: Ctx,
  o: { stagingDir: string; entry: PinEntry; dest: string; localExe: string | null; placed: string },
): Promise<BootstrapError | null> {
  const expected = pushShaOf(o.entry);
  const canPush = c.sameOs && o.localExe !== null && expected !== null;
  if (!c.noDownload) {
    const r = await c.run(
      downloadCommand(c.family, { stagingDir: o.stagingDir, pins: [pinOf(o.entry, o.dest)] }),
      DOWNLOAD_TIMEOUT_MS,
    );
    const line = parseResultLine(r.stdout);
    if (line?.ok === true) return null;
    if (line === null && r.failure !== null) return r.failure;
    // A checksum or unpack failure is not a download failure: the bytes arrived and were wrong.
    if (line?.ok === false && line.step !== 'download') {
      return { code: 'install_failed', step: line.step, detail: line.detail };
    }
    if (!canPush) {
      const detail = line?.ok === false ? line.detail : 'the download printed no result';
      return {
        code: 'install_failed',
        step: 'download',
        detail: `${detail}; ${pushRefusal(c, o, expected)}`,
      };
    }
  } else if (!canPush) {
    return { code: 'install_failed', step: 'download', detail: pushRefusal(c, o, expected) };
  }
  if (o.localExe === null || expected === null) {
    return { code: 'install_failed', step: 'download', detail: pushRefusal(c, o, expected) };
  }
  const data = await readFile(o.localExe);
  if (sha256Of(data) !== expected) {
    return {
      code: 'install_failed',
      step: 'checksum',
      detail: `this controller's ${o.dest} is not the pinned binary`,
    };
  }
  const r = await c.run(
    receiveFileCommand(c.family, { path: o.placed, sha256: expected, size: data.length }),
    DOWNLOAD_TIMEOUT_MS,
    data,
  );
  return scriptError(r, 'download');
}

function pushRefusal(c: Ctx, o: { localExe: string | null }, expected: string | null): string {
  if (expected === null) {
    return 'the pin has no binSha256, so this controller will not push the binary (fail closed)';
  }
  if (!c.sameOs) return 'B needs internet, or a controller on the same OS';
  if (o.localExe === null) {
    return 'this controller has no copy to push (a dev build needs CONDUIT_NODE_BINARY)';
  }
  return 'B needs internet, or a controller on the same OS';
}

/** The server tree: A's bundle packed as ustar, each file checked by the remote (plan decision 6). */
async function pushTree(c: Ctx, dir: string, files: TreeFile[]): Promise<BootstrapError | null> {
  const r = await c.run(
    receiveTreeCommand(c.family, { dir, manifest: manifestOf(files) }),
    TREE_TIMEOUT_MS,
    packTree(files),
  );
  return scriptError(r, 'unpack');
}

async function finalize(c: Ctx, root: string, version: string): Promise<BootstrapError | null> {
  const r = await c.run(
    finalizeCommand(c.family, { runtimeRoot: root, version }),
    FINALIZE_TIMEOUT_MS,
  );
  return scriptError(r, 'unpack');
}

/**
 * Lays out one version, as prepareRuntime does (plan decision 3, RS-D11): node and the server tree
 * in <ver>.tmp, the shim dir, and hc in conduit-hc/<hcVersion>.tmp; each renamed into place last.
 */
async function install(
  c: Ctx,
  version: string,
  nodeName: string,
  hcName: string,
  shimName: string,
): Promise<BootstrapError | null> {
  const { rp } = c;
  const appTmp = rp.join(c.runtimeRoot, `${version}.tmp`);
  const hcTmp = rp.join(c.hcRoot, `${HC_PINNED_VERSION}.tmp`);
  const remotePins = c.pins[c.os === 'windows' ? 'win32-x64' : 'linux-x64'];

  const node = await stageBinary(c, {
    stagingDir: appTmp,
    entry: remotePins.node,
    dest: nodeName,
    localExe: c.runtime.nodeExe,
    placed: rp.join(appTmp, nodeName),
  });
  if (node) return node;
  const tree = await pushTree(c, rp.join(appTmp, 'server'), await treeOf(c.runtime.serverDir));
  if (tree) return tree;
  const appFinal = await finalize(c, c.runtimeRoot, version);
  if (appFinal) return appFinal;

  const hc = await stageBinary(c, {
    stagingDir: hcTmp,
    entry: remotePins.hc,
    dest: hcName,
    localExe: c.runtime.hcExe,
    placed: rp.join(hcTmp, hcName),
  });
  if (hc) return hc;
  const hcFinal = await finalize(c, c.hcRoot, HC_PINNED_VERSION);
  if (hcFinal) return hcFinal;

  // The shim dir: the shim file is pushed, and the node is copied on B from the install above.
  // The copy works on any remote that could fetch its node, so it needs no sha check of A's bytes.
  const shimTmp = c.rp.join(c.runtimeRoot, `${shimName}.tmp`);
  const shim = await pushTree(c, shimTmp, [
    { path: SHIM_LEAF, data: await readFile(c.runtime.shimFile), mode: 0o644 },
  ]);
  if (shim) return shim;
  const copy = await c.run(
    copyNodeIntoShimCommand(c.family, {
      runtimeRoot: c.runtimeRoot,
      version,
      shimDir: rp.join(c.runtimeRoot, shimName),
    }),
    FINALIZE_TIMEOUT_MS,
  );
  const copied = scriptError(copy, 'unpack');
  if (copied) return copied;
  return finalize(c, c.runtimeRoot, shimName);
}

async function bootstrapOnce(o: BootstrapperOptions, target: string): Promise<BootstrapOutcome> {
  const run = (command: RemoteCommand, timeoutMs: number, stdin?: Buffer) =>
    o.exec({
      ...o.ssh,
      target,
      command,
      timeoutMs,
      ...(stdin ? { stdin } : {}),
    });

  // 1. The family: which shell the probe must be written for (decision 1).
  const fam = await run({ command: FAMILY_PROBE }, PROBE_TIMEOUT_MS);
  const family = parseFamily(fam.stdout);
  if (family === null) {
    return fail(
      fam.failure ?? {
        code: 'ssh_failed',
        detail: 'the remote shell is not sh, PowerShell or cmd.exe',
      },
    );
  }

  // 2. The probe, then the plan. Unsupported and incompatible stop before anything is copied.
  const pr = await run(probeCommand(family), PROBE_TIMEOUT_MS);
  const probed = parseProbe(pr.stdout);
  if ('error' in probed) {
    return fail(pr.failure ?? { code: 'ssh_failed', detail: probed.detail });
  }
  const plan = planInstall({ version: o.local.version, linkMajor: o.local.linkMajor }, probed);
  if (plan.kind === 'unsupported') {
    return fail({ code: 'remote_unsupported', os: plan.os, arch: plan.arch });
  }
  if (plan.kind === 'incompatible') return fail({ code: 'peer_incompatible', remote: plan.remote });

  const os: 'linux' | 'windows' = probed.os === 'windows' ? 'windows' : 'linux';
  const rp = os === 'windows' ? path.win32 : path.posix;
  const hostPlatform = os === 'windows' ? 'win32' : 'linux';
  const runtimeRoot = rp.join(probed.userData, 'runtime');
  const hcRoot = rp.join(runtimeRoot, 'conduit-hc');
  const shimName = shimDirName(CURRENT_SHIM_GENERATION);
  const nodeName = runtimeBinaryName('node', hostPlatform);
  const hcName = runtimeBinaryName('hc', hostPlatform);

  // 3. Which version to run, and whether to copy. An attach runs the recorded version when its dir
  // is there. Otherwise the local build is installed, so ensure has a node and main.js to run; the
  // running newer server then answers and is never downgraded (ensure-server.ts).
  const localPresent = probed.installed.includes(o.local.version);
  const recordedPresent = plan.kind === 'attach' && probed.installed.includes(plan.version);
  const version = recordedPresent && plan.kind === 'attach' ? plan.version : o.local.version;
  const needsCopy = plan.kind === 'attach' ? !recordedPresent : !localPresent;
  const copied = needsCopy && !localPresent;

  const ctx: Ctx = {
    family,
    rp,
    os,
    runtimeRoot,
    hcRoot,
    pins: o.pins ?? DEFAULT_PINS,
    noDownload: o.noDownload,
    runtime: o.runtime,
    sameOs: o.local.platform === hostPlatform && o.local.arch === 'x64' && probed.arch === 'x64',
    run,
  };
  if (copied) {
    const failure = await install(ctx, o.local.version, nodeName, hcName, shimName);
    if (failure) return fail(failure);
  }

  // 4. Ensure: the installed node starts the server under the probe's start method.
  const start = startMethodOf(probed);
  const appDir = rp.join(runtimeRoot, version);
  const mainJs = rp.join(appDir, 'server', 'main.js');
  const node = rp.join(appDir, nodeName);
  const ensure = await run(
    ensureCommand(family, {
      node,
      mainJs,
      userData: probed.userData,
      method: start.method,
      survivesLogout: start.survivesLogout,
      shimDir: rp.join(runtimeRoot, shimName),
      hcExe: rp.join(hcRoot, HC_PINNED_VERSION, hcName),
    }),
    ENSURE_TIMEOUT_MS,
  );
  const line = parseResultLine(ensure.stdout);
  if (line === null) {
    return fail(
      ensure.failure ?? {
        code: 'install_failed',
        step: 'start',
        detail: 'the ensure step printed no result',
      },
    );
  }
  if (!line.ok) return fail({ code: 'install_failed', step: line.step, detail: line.detail });

  return {
    ok: true,
    ssh: { target, node, mainJs, userData: probed.userData },
    summary: {
      os,
      arch: 'x64',
      installed: copied && plan.kind !== 'upgrade',
      upgraded: copied && plan.kind === 'upgrade',
      reused: !copied,
      survivesLogout: line.survivesLogout === true,
      version: typeof line.version === 'string' ? line.version : version,
    },
  };
}

/**
 * The bootstrap for one target. Concurrent calls for a target share one run (plan T4.2), so two
 * clicks cannot race two installs into the same tmp folders.
 */
export function createBootstrapper(
  o: BootstrapperOptions,
): (target: string) => Promise<BootstrapOutcome> {
  const inflight = new Map<string, Promise<BootstrapOutcome>>();
  return (target) => {
    const existing = inflight.get(target);
    if (existing) return existing;
    const started = bootstrapOnce(o, target).catch(
      (error: unknown): BootstrapOutcome =>
        fail({
          code: 'install_failed',
          step: 'disk',
          detail: error instanceof Error ? error.message : String(error),
        }),
    );
    const settled = started.finally(() => inflight.delete(target));
    inflight.set(target, settled);
    return settled;
  };
}
