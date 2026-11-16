import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchDir } from '../../electron/watch-dir';
import type { McpNetworkPort, NetworkPort } from '../../src/conduit-mcp/remote-routing';
import {
  type Capabilities,
  LINK_PROTOCOL,
  type LinkState,
  OWN_DEFAULT_CAPABILITIES,
  type RequestAnswerBody,
} from '../../src/contracts/link-protocol';
import type { NetworkState } from '../../src/contracts/network-state';
import type { ServerEventSink } from '../../src/contracts/server-ports';
import type { ServerSettings } from '../../src/contracts/server-protocol';
import type { AddSshPeerResult, BootstrapResult, SshEndpoint } from '../../src/contracts/ssh-link';
import type { TerminalRuntime } from '../../src/contracts/terminal-runtime';
import { readDir, readFile } from '../../src/file-service';
import { bindableAddresses } from '../../src/network/bind-addresses';
import type { PairingOutcome } from '../../src/network/pairing-protocol';
import { createRemoteDirectory } from '../../src/network/remote-directory';
import { selfSignedCert } from '../../src/network/self-signed-cert';
import { controlDir } from '../../src/network/ssh-argv';
import { parseSshConfigHosts } from '../../src/network/ssh-config-hosts';
import type { SessionCommand } from '../../src/types';
import { currentWindowsPty } from '../../src/windows-pty-info';
import {
  removeLinkEndpoint,
  removeServerVersion,
  writeLinkEndpoint,
  writeServerVersion,
} from '../lifecycle/server-secret';
import { type AuditSink, openAuditLog, teeAudit } from './audit-log';
import {
  type BootstrapperOptions,
  createAgentProbe,
  createBootstrapper,
  machineMetaOf,
} from './bootstrap';
import { handleNetworkCall } from './c2';
import { createCalls, isDialedSsh } from './calls';
import { createDrive, type Drive, type DriveDeps } from './drive';
import { createFsClient } from './fs-client';
import { createFsServe } from './fs-serve';
import { createGitClient } from './git-client';
import { adoptOwnerKey, type Identity, setOwnerKey } from './identity';
import { createLinkManager, type LinkManager } from './link-manager';
import { openLinkStore } from './link-store';
import { type LinkListener, listenLinks, listenPairing, type NetLog } from './listener';
import { createMachines, type Machines } from './machines';
import { createMessaging } from './messaging';
import { createMonitorPublisher, type MonitorSource } from './monitor-publisher';
import { createNeedsPerson, createSetupPane } from './needs-person';
import { createPairingPort } from './pairing-port';
import { createPairingService, type PairingService } from './pairing-service';
import {
  createRequests,
  type RemoteAnswerResult,
  type RequestMirrorSink,
  type RequestMirrorSource,
  type Requests,
} from './requests';
import { createSnapshotCoalescer } from './snapshot-coalescer';
import { createSshDial, prepareControlDir } from './ssh-dialer';
import { sshExec } from './ssh-exec';
import { listenStdioLink, type StdioLinkEndpoint } from './stdio-link-endpoint';
import { createViewRelay } from './view-relay';

// The one composer for linked machines (plan "Technical decisions" 1): services.ts only builds,
// starts, stops and routes C2 calls here.

type NetworkSettings = Pick<ServerSettings, 'networkBindHost' | 'networkPort' | 'networkSelfName'>;

export interface NetworkDeps {
  /** <userData>/network */
  dir: string;
  /** The server's userData: the ssh control dir lives beside it. */
  userData: string;
  /** The server's own version, recorded in `server-version` after it listens. */
  appVersion: string;
  /** The instance digest: names the ssh control dir's fallback when userData is too long. */
  instance: string;
  /** The stdio link endpoint the ssh bridge connects to; the server's names.linkEndpoint. */
  linkEndpoint: string;
  /** The per-start secret a bridge's preamble must carry; read at each preamble, never per connection. */
  secret: () => string;
  /** e2e only: the leading argv of the ssh stand-in (readE2eSshArgsPrefix). Absent in production. */
  sshArgsPrefix?: string[];
  identity: Identity;
  settings(): NetworkSettings;
  emit(state: NetworkState): void;
  log: NetLog & {
    info(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
  now?: () => number;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hostname?: () => string;
  /** This server's sessions, asks and agents as linked peers may see them (monitor push). */
  monitor: MonitorSource;
  observe: TerminalRuntime['observe'];
  /** The server's side of drive: the human input path, sessions and folders. */
  drive: Pick<
    DriveDeps,
    | 'applyHumanInput'
    | 'resize'
    | 'liveSession'
    | 'agentExists'
    | 'isDirectory'
    | 'openSession'
    | 'closeSession'
  >;
  emitTo(peer: object, ...event: Parameters<ServerEventSink>): void;
  /** Opens a visible command session (the needs-person pane); resolves with its id. */
  openCommandSession(command: SessionCommand, folder: string): Promise<string>;
  /** This server's own runtime and platform, for pushing it to a remote (bootstrap.ts). */
  bootstrap: NetworkBootstrapDeps;
  /** A session's home and roots on this machine, or null for an unknown session (fs-serve.ts). */
  sessionRoots(sessionId: string): readonly string[] | null;
  /** The user's ssh config text, or null when there is none. Production reads ~/.ssh/config. */
  readSshConfig?: () => string | null;
  /** The request service's two ports (CON-42): B's requests and answer path, and A's mirror store. */
  requestPorts: { b: RequestMirrorSource; a: RequestMirrorSink };
}

/** ~/.ssh/config as text; a missing file is null, any other read error is the caller's to see. */
function readUserSshConfig(): string | null {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export type NetworkBootstrapDeps = Pick<BootstrapperOptions, 'local' | 'runtime' | 'noDownload'>;

export interface NetworkService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A C2 call for pairing.* / link.*, or null when the method isn't the network's. */
  handle(method: string, params: unknown, peer?: object): Promise<unknown> | null;
  disconnected(peer: object): void;
  /** Server settings changed: re-bind the listener if its host or port changed. */
  settingsChanged(): Promise<void>;
  state(): NetworkState;
  onRevoked(listener: (machineId: string) => void): () => void;
  /** Dials an ssh target and links it; the C2 link.sshAdd call lands here. */
  addSshPeer(ssh: SshEndpoint): Promise<AddSshPeerResult>;
  /** Installs or attaches the remote, then links it: the C2 link.sshBootstrap call lands here. */
  bootstrap(target: string): Promise<BootstrapResult>;
  /** Every audit event also goes to this sink, set once the MCP side exists. */
  setAuditTap(tap: AuditSink): void;
  /** What the MCP host reads: remote sessions, address resolution, the outbox. */
  port(): NetworkPort;
  /** The MCP host's side, set once it exists (the host is built after the network). */
  setMcp(port: McpNetworkPort): void;
  /** Something local a peer may see changed: sessions, asks, unread, presence. */
  localChanged(): void;
  /** Answers a request of a machine I dialed over ssh (CON-42); never re-sent. */
  answerRemoteRequest(
    machineId: string,
    requestId: string,
    answer: RequestAnswerBody,
  ): Promise<RemoteAnswerResult>;
}

const EMIT_COALESCE_MS = 50;

export function createNetwork(deps: NetworkDeps): NetworkService {
  const now = deps.now ?? Date.now;
  let identity = deps.identity;
  const cert = () =>
    selfSignedCert(
      { publicKey: identity.serverPublicKey, privateKey: identity.serverPrivateKey },
      identity.machineId,
    );
  const tlsPair = {
    cert: cert(),
    key: identity.serverPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const selfName = () => deps.settings().networkSelfName || (deps.hostname ?? os.hostname)();
  const after = (fn: () => void, ms: number) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return () => clearTimeout(h);
  };
  const store = openLinkStore(path.join(deps.dir, 'links.json'), { now, log: deps.log });
  const fileAudit = openAuditLog(path.join(deps.dir, 'audit.jsonl'), {
    now,
    onError: (err) => deps.log.error('network audit write failed', { message: err.message }),
  });
  const tee = teeAudit(fileAudit, (err) =>
    deps.log.error('network audit tap failed', { message: err.message }),
  );
  const audit = tee.sink;

  let emitTimer: (() => void) | null = null;
  let mcp: McpNetworkPort | null = null;
  const portListeners = new Set<() => void>();
  const directory = createRemoteDirectory(() => identity.machineId);
  /** The last state each link was seen in, to act once on up and down. */
  const seen = new Map<string, LinkState>();
  /** My capabilities per link as last seen, to push a fresh snapshot when they change. */
  const capsSeen = new Map<string, string>();
  const live = (st: LinkState | undefined) => st === 'up' || st === 'degraded';
  const capsKey = (c: Capabilities): string => `${c.messaging}/${c.monitor}/${c.drive}`;

  // Runs on every link change, synchronously, so remote rows and the outbox follow at once;
  // only the C2 broadcast below is coalesced.
  const onLinksChanged = (): void => {
    const views = manager.views();
    directory.setLinks(
      views.map((v) => ({
        machineId: v.machineId,
        name: v.name,
        state: v.state,
        peerCapabilities: v.peerCapabilities,
      })),
      selfName(),
    );
    for (const v of views) {
      const before = seen.get(v.machineId);
      seen.set(v.machineId, v.state);
      const capsBefore = capsSeen.get(v.machineId);
      const capsNow = capsKey(v.capabilities);
      capsSeen.set(v.machineId, capsNow);
      if (live(v.state) && !live(before)) {
        messaging.linkUp(v.machineId);
        publisher.pushTo(v.machineId);
      } else if (!live(v.state) && live(before)) messaging.linkDown(v.machineId);
      // What the peer sees depends on these, so a change is pushed at once, not only on up.
      else if (live(v.state) && capsBefore !== undefined && capsBefore !== capsNow)
        publisher.pushTo(v.machineId);
      relay.linkChanged(v.machineId);
      drive.linkChanged(v.machineId);
      calls.linkChanged(v.machineId);
      if (!live(v.state)) fsServe.linkDown(v.machineId);
    }
    // A forgotten link has no view left, so the hooks run for the id it had and its maps are cleared.
    const linkedNow = new Set(views.map((v) => v.machineId));
    for (const [machineId, before] of [...seen]) {
      if (linkedNow.has(machineId)) continue;
      seen.delete(machineId);
      capsSeen.delete(machineId);
      if (live(before)) messaging.linkDown(machineId);
      relay.linkChanged(machineId);
      drive.linkChanged(machineId);
      fsServe.linkDown(machineId);
    }
    calls.settleAbsent(views.map((v) => v.machineId));
    fsClient.linksChanged(views);
    gitClient.linksChanged(views);
    requests.linksChanged();
    for (const l of portListeners) l();
  };

  const changed = (): void => {
    onLinksChanged();
    if (emitTimer) return;
    emitTimer = after(() => {
      emitTimer = null;
      deps.emit(state());
    }, EMIT_COALESCE_MS);
  };

  // A peer's snapshots are applied at most once per window, so a burst costs one recompute.
  const snapshots = createSnapshotCoalescer({
    now,
    after,
    apply: (machineId, snapshot) => {
      directory.apply(machineId, snapshot);
      for (const l of portListeners) l();
      changed();
    },
  });

  let listener: LinkListener | null = null;
  let stdioLink: StdioLinkEndpoint | null = null;
  let bound: { host: string; port: number } | null = null;
  let listening: Promise<string[]> | null = null;

  const sshControlDir = controlDir({
    userData: deps.userData,
    tmpdir: os.tmpdir(),
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    // win32 has no getuid; there the uid only names the tmpdir fallback, and the dialer skips the owner check.
    uid: process.getuid?.() ?? 0,
    instance: deps.instance,
    join: path.join,
  });

  const bootstrapper = createBootstrapper({
    ...deps.bootstrap,
    exec: sshExec,
    ssh: {
      sshPath: process.env.CONDUIT_SSH_PATH || 'ssh',
      sshArgsPrefix: deps.sshArgsPrefix,
      controlDir: sshControlDir,
    },
  });

  const manager: LinkManager = createLinkManager({
    identity: () => identity,
    appVersion: deps.appVersion,
    sshDial: createSshDial({
      sshPath: process.env.CONDUIT_SSH_PATH || 'ssh',
      controlDir: sshControlDir,
      log: deps.log,
      sshArgsPrefix: deps.sshArgsPrefix,
    }),
    selfName,
    tls: () => tlsPair,
    store,
    audit,
    log: deps.log,
    now,
    rand: Math.random,
    after,
    onFrame: (machineId, f) => {
      if (f.t === 'snapshot') snapshots.offer(machineId, f.snapshot);
      else if (f.t === 'msg' || f.t === 'ack' || f.t === 'receipt') messaging.onFrame(machineId, f);
      else if (
        f.t === 'drive.input' ||
        f.t === 'drive.resize' ||
        f.t === 'drive.open' ||
        f.t === 'drive.close' ||
        f.t === 'drive.result'
      )
        void drive
          .onFrame(machineId, f)
          .catch((err: unknown) => deps.log.error('drive frame failed', { message: String(err) }));
      else if (f.t === 'call')
        void calls
          .serveCall(machineId, f)
          .catch((err: unknown) => deps.log.error('call failed', { message: String(err) }));
      else if (f.t === 'call.result') calls.onResult(machineId, f);
      else if (f.t === 'fs.res' || f.t === 'fs.changed') fsClient.onFrame(machineId, f);
      else if (f.t === 'git.res') gitClient.onFrame(machineId, f);
      else if (f.t === 'fs.req' || f.t === 'fs.watch' || f.t === 'fs.unwatch')
        void fsServe
          .onFrame(machineId, f)
          .catch((err: unknown) => deps.log.error('fs frame failed', { message: String(err) }));
      else if (f.t === 'request.mirror' || f.t === 'request.answer' || f.t === 'request.answered')
        void requests
          .onFrame(machineId, f)
          .catch((err: unknown) =>
            deps.log.error('request frame failed', { message: String(err) }),
          );
      else if (
        f.t === 'view.open' ||
        f.t === 'view.opened' ||
        f.t === 'view.data' ||
        f.t === 'view.size' ||
        f.t === 'view.end' ||
        f.t === 'view.close'
      )
        void relay
          .onFrame(machineId, f)
          .catch((err: unknown) => deps.log.error('view frame failed', { message: String(err) }));
    },
    changed,
    onOwnerKey: (pair) => onOwnerKey(pair),
    reconnected: (machineId) => {
      messaging.reconnected(machineId);
      publisher.pushTo(machineId);
      fsClient.reconnected(machineId);
      gitClient.reconnected(machineId);
    },
  });

  // The link is made only after the remote's ensure step has reported its server up.
  const bootstrapAndLink = async (target: string): Promise<BootstrapResult> => {
    const outcome = await bootstrapper(target);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const linked = await manager.addSshPeer(outcome.ssh);
    if (!linked.ok) return { ok: false, error: linked.error };
    // The pin just made is an ssh record, so the meta always lands; a null here is a store bug.
    if (store.setMachine(linked.machineId, machineMetaOf(outcome.summary)) === null) {
      return { ok: false, error: { code: 'ssh_failed', detail: 'machine record not written' } };
    }
    return { ok: true, machineId: linked.machineId, ssh: outcome.ssh, summary: outcome.summary };
  };

  const paneOptions = {
    sshPath: process.env.CONDUIT_SSH_PATH || 'ssh',
    sshArgsPrefix: deps.sshArgsPrefix,
    controlDir: sshControlDir,
    prepareControlDir: (dir: string) => prepareControlDir(dir, deps.log),
    openCommand: deps.openCommandSession,
    home: os.homedir(),
  };
  const openNeedsPerson = createNeedsPerson(paneOptions);
  const openSetupPane = createSetupPane({
    ...paneOptions,
    machineOf: (machineId) => {
      const record = store.get(machineId);
      if (record === null || record.transport !== 'ssh' || record.ssh === null) return null;
      return {
        target: record.ssh.target,
        os: record.machine?.os ?? null,
        mode: record.machine?.mode ?? null,
      };
    },
  });
  const probeAgents = createAgentProbe({
    ssh: {
      sshPath: process.env.CONDUIT_SSH_PATH || 'ssh',
      sshArgsPrefix: deps.sshArgsPrefix,
      controlDir: sshControlDir,
    },
    exec: sshExec,
  });

  const machines: Machines = createMachines({
    manager,
    store,
    bootstrap: bootstrapAndLink,
    directory,
    probe: probeAgents,
    changed,
  });

  const sshHosts = (): string[] => {
    const text = (deps.readSshConfig ?? readUserSshConfig)();
    return text === null ? [] : parseSshConfigHosts(text);
  };

  const linkInfo = () =>
    manager.views().map((v) => ({
      machineId: v.machineId,
      state: v.state,
      capabilities: v.capabilities,
      peerCapabilities: v.peerCapabilities,
    }));
  const relay = createViewRelay({
    links: linkInfo,
    sessions: deps.monitor.sessions,
    observe: deps.observe,
    windowsPty: () => currentWindowsPty() ?? null,
    send: (machineId, frame) => manager.send(machineId, frame),
    emitTo: deps.emitTo,
    now,
    newId: () => `v_${randomBytes(16).toString('hex')}`,
    log: (message) => deps.log.warn(message),
  });
  const drive: Drive = createDrive({
    ...deps.drive,
    links: linkInfo,
    dialedSsh: (machineId) => isDialedSsh(store.get(machineId)),
    send: (machineId, frame) => manager.send(machineId, frame),
    audit,
    now,
    newId: () => `d_${randomBytes(12).toString('hex')}`,
    after,
    log: (message) => deps.log.warn(message),
  });
  const calls = createCalls({
    linkOf: (machineId) => store.get(machineId),
    linkState: (machineId) => manager.view(machineId)?.state ?? null,
    peerMinor: (machineId) => manager.peerMinor(machineId),
    mcp: () => mcp,
    send: (machineId, frame) => manager.send(machineId, frame),
    audit,
    now,
    newId: () => `c_${randomBytes(12).toString('hex')}`,
    after,
    log: (message, data) => deps.log.info(message, data),
  });
  const fsClient = createFsClient({
    linkOf: (machineId) => store.get(machineId),
    linkState: (machineId) => manager.view(machineId)?.state ?? null,
    peerMinor: (machineId) => manager.peerMinor(machineId),
    send: (machineId, frame) => manager.send(machineId, frame),
    emitTo: deps.emitTo,
    audit,
    now,
    newId: () => `f_${randomBytes(12).toString('hex')}`,
    after,
  });
  const gitClient = createGitClient({
    linkOf: (machineId) => store.get(machineId),
    linkState: (machineId) => manager.view(machineId)?.state ?? null,
    peerMinor: (machineId) => manager.peerMinor(machineId),
    send: (machineId, frame) => manager.send(machineId, frame),
    audit,
    now,
    newId: () => `g_${randomBytes(12).toString('hex')}`,
    after,
  });
  const fsServe = createFsServe({
    linkOf: (machineId) => store.get(machineId),
    linkState: (machineId) => manager.view(machineId)?.state ?? null,
    sessionRoots: deps.sessionRoots,
    readDir,
    readFile,
    stat: async (absPath) => {
      const st = await fs.promises.stat(absPath);
      return {
        kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    },
    watchDir,
    send: (machineId, frame) => {
      manager.send(machineId, frame);
    },
    audit,
    now,
  });
  const requests: Requests = createRequests({
    b: deps.requestPorts.b,
    a: deps.requestPorts.a,
    links: () => manager.views().map((v) => ({ machineId: v.machineId, state: v.state })),
    linkOf: (machineId) => store.get(machineId),
    peerMinor: (machineId) => manager.peerMinor(machineId),
    send: (machineId, frame) => manager.send(machineId, frame),
    audit,
    now,
    after,
    newId: () => `q_${randomBytes(12).toString('hex')}`,
  });
  const messaging = createMessaging({
    file: path.join(deps.dir, 'outbox.json'),
    machineId: () => identity.machineId,
    links: linkInfo,
    send: (machineId, frame) => manager.send(machineId, frame),
    mcp: () => mcp,
    audit,
    log: deps.log,
    now,
    after,
  });
  const publisher = createMonitorPublisher({
    source: deps.monitor,
    links: () =>
      linkInfo().map((l) => ({ ...l, peerMinor: manager.peerMinor(l.machineId) ?? undefined })),
    send: (machineId, frame) => manager.send(machineId, frame),
    after,
  });
  manager.onRevoked((machineId) => messaging.revoked(machineId));

  const networkPort: NetworkPort = {
    remoteEntries: () => directory.entries(),
    resolve: (target) => directory.resolve(target),
    enqueue: (msg, recipients) => messaging.enqueue(msg, recipients),
    waitReading: (address, caller) => directory.waitReading(address, caller),
    peerCapabilitiesOf: (machineId) => {
      const v = manager.view(machineId);
      return v &&
        v.state !== 'revoked' &&
        v.state !== 'incompatible' &&
        v.state !== 'identity-changed'
        ? v.peerCapabilities
          ? { ...v.peerCapabilities }
          : null
        : null;
    },
    onChange(listener) {
      portListeners.add(listener);
      return () => portListeners.delete(listener);
    },
    listMachines: () => machines.list(),
    call: (machineId, tool, args, principalHandle, signal) =>
      calls.call(machineId, tool, args, principalHandle, signal),
    connectMachine: (machine, signal) => machines.connect(machine, signal),
    disconnectMachine: (machine) => machines.disconnect(machine),
    answerRemoteRequest: async (machineId, requestId, answer) => {
      const sent = await requests.answerRemote(machineId, requestId, answer);
      return sent.ok ? { ok: true, value: null } : sent;
    },
    selfName,
  };

  const hosts = (): string[] => {
    const s = deps.settings();
    const found = bindableAddresses((deps.interfaces ?? os.networkInterfaces)(), s.networkBindHost);
    if (found.length === 0) throw new Error(`no address to listen on for "${s.networkBindHost}"`);
    return found;
  };

  const ensureListening = (): Promise<string[]> => {
    if (listener) return Promise.resolve(listener.addresses());
    listening ??= (async () => {
      const s = deps.settings();
      listener = await listenLinks({
        hosts: hosts(),
        port: s.networkPort,
        ...tlsPair,
        trustedCerts: () => store.trustedCerts(),
        knows: (k) => manager.knows(k),
        onLink: (sock, k) => manager.accept(sock, k),
        log: deps.log,
      });
      bound = { host: s.networkBindHost, port: s.networkPort };
      changed();
      return listener.addresses();
    })().finally(() => {
      listening = null;
    });
    return listening;
  };

  // The pairing port sits next to the link port; an ephemeral link port (tests) gets one too.
  const pairingPort = createPairingPort(() => {
    const s = deps.settings();
    return listenPairing({
      hosts: hosts(),
      port: s.networkPort === 0 ? 0 : s.networkPort + 1,
      onPairing: (sock) => pairing.onPairingSocket(sock),
      log: deps.log,
    });
  });
  const openPairingPort = (): Promise<string[]> => pairingPort.open();
  const closePairingPort = (): void => pairingPort.close();

  const onOwnerKey = (pair: { publicKey: string; privateKey: string }): boolean => {
    try {
      const next = adoptOwnerKey(deps.dir, identity, pair);
      if (next === null) {
        deps.log.warn('owner key refused');
        return false;
      }
      identity = next;
      return true;
    } catch (err) {
      deps.log.warn('owner key refused', {
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const onLinked = (
    outcome: Extract<PairingOutcome, { kind: 'linked' }>,
    dialedAddress: string | null,
  ): boolean => {
    // Machine ids are short enough to grind: a new key must not take over another link's record.
    if (store.conflicts(outcome.peer.machineId, outcome.peer.serverKey)) {
      deps.log.warn('pairing refused: machine id already linked under another key', {
        peer: outcome.peer.machineId,
      });
      return false;
    }
    if (outcome.ownerKeyToStore) {
      identity = setOwnerKey(deps.dir, identity, {
        publicKey: createPublicKey({
          key: Buffer.from(outcome.ownerKeyToStore.publicKey, 'base64'),
          format: 'der',
          type: 'spki',
        }),
        privateKey: createPrivateKey({
          key: Buffer.from(outcome.ownerKeyToStore.privateKey, 'base64'),
          format: 'der',
          type: 'pkcs8',
        }),
      });
    }
    const addresses = [
      ...new Set([...(dialedAddress ? [dialedAddress] : []), ...outcome.peer.addresses]),
    ];
    manager.add({
      linkId: outcome.linkId,
      machineId: outcome.peer.machineId,
      serverKey: outcome.peer.serverKey,
      ownerKey: outcome.peer.ownerKey,
      name: outcome.peer.selfName,
      trust: 'own',
      addresses,
      capabilities: { ...OWN_DEFAULT_CAPABILITIES },
      fingerprint: outcome.fingerprint,
      createdAt: new Date(now()).toISOString(),
      cert: outcome.peer.cert,
      ownerTransfer: outcome.ownerTransfer,
      transport: 'tls',
      ssh: null,
      machine: null,
    });
    listener?.refreshTrust();
    void ensureListening().catch((err: Error) =>
      deps.log.warn('link listener did not start after pairing', { message: err.message }),
    );
    return true;
  };

  const pairing: PairingService = createPairingService({
    identity: () => identity,
    selfName,
    cert: () => tlsPair.cert,
    linkAddresses: ensureListening,
    openPairingPort,
    closePairingPort,
    onLinked,
    ownerPending: () => store.links().some((l) => l.ownerTransfer === 'receive'),
    generateOwnerKey: () => {
      const k = generateKeyPairSync('ed25519');
      return {
        publicKey: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        privateKey: k.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      };
    },
    audit,
    changed,
    now,
    rand: (n) => randomBytes(n),
    after,
    newId: () => `p_${randomBytes(8).toString('hex')}`,
  });

  const state = (): NetworkState => ({
    machineId: identity.machineId,
    selfName: selfName(),
    listening: listener?.addresses() ?? [],
    links: manager
      .views()
      .map((v) => ({ ...v, trust: 'own' as const, snapshot: directory.snapshotOf(v.machineId) })),
    pairing: pairing.view(),
    machines: machines.list(),
  });

  const closeListener = async (): Promise<void> => {
    const l = listener;
    listener = null;
    bound = null;
    await l?.close();
  };

  return {
    async start() {
      messaging.start();
      manager.start();
      // A record a crashed run left names an endpoint this run may not own. Drop it before the
      // listen, so a failed listen can never leave a record that sends the bridge to someone else.
      try {
        removeLinkEndpoint(deps.userData);
      } catch (err) {
        deps.log.error('stale link endpoint record not removed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // Not fatal: C2 and TLS links still work without the ssh bridge's endpoint.
      stdioLink = await listenStdioLink({
        endpoint: deps.linkEndpoint,
        platform: process.platform,
        secret: deps.secret,
        accept: (stream) => manager.acceptStream(stream),
        audit,
        log: deps.log,
      }).catch((err: Error) => {
        deps.log.error('stdio link endpoint did not start', { message: err.message });
        return null;
      });
      if (stdioLink) {
        try {
          writeLinkEndpoint(deps.userData, deps.linkEndpoint);
        } catch (err) {
          deps.log.error('link endpoint record not written', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        writeServerVersion(deps.userData, {
          version: deps.appVersion,
          linkMajor: LINK_PROTOCOL.major,
        });
      } catch (err) {
        deps.log.error('server version record not written', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (store.links().length > 0) {
        await ensureListening().catch((err: Error) =>
          deps.log.warn('link listener did not start', { message: err.message }),
        );
      }
    },
    async stop() {
      // Closed first, so no ssh stream is admitted while the manager winds its links down.
      const endpoint = stdioLink;
      stdioLink = null;
      await endpoint?.close();
      if (endpoint) {
        try {
          removeLinkEndpoint(deps.userData);
        } catch (err) {
          deps.log.error('link endpoint record not removed', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        removeServerVersion(deps.userData);
      } catch (err) {
        deps.log.error('server version record not removed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      emitTimer?.();
      snapshots.stop();
      closePairingPort();
      relay.stop();
      drive.stop();
      calls.stop();
      fsClient.stop();
      gitClient.stop();
      requests.stop();
      publisher.stop();
      messaging.stop();
      await manager.stop();
      await closeListener();
    },
    handle: (method, params, peer) =>
      handleNetworkCall(method, params, {
        pairing,
        manager,
        state,
        relay,
        drive,
        bootstrap: bootstrapAndLink,
        openNeedsPerson,
        openSetupPane,
        machines,
        sshHosts,
        fs: fsClient,
        git: gitClient,
        peer,
      }),
    disconnected: (peer) => {
      relay.disconnected(peer);
      fsClient.peerGone(peer);
    },
    async settingsChanged() {
      const s = deps.settings();
      if (bound && (bound.host !== s.networkBindHost || bound.port !== s.networkPort)) {
        await closeListener();
        await ensureListening().catch((err: Error) =>
          deps.log.warn('link listener did not restart', { message: err.message }),
        );
      }
      changed();
    },
    state,
    onRevoked: (l) => manager.onRevoked(l),
    addSshPeer: (ssh) => manager.addSshPeer(ssh),
    bootstrap: bootstrapAndLink,
    setAuditTap(tap) {
      tee.setTap(tap);
    },
    port: () => networkPort,
    setMcp(port) {
      mcp = port;
    },
    localChanged: () => publisher.changed(),
    answerRemoteRequest: (machineId, requestId, answer) =>
      requests.answerRemote(machineId, requestId, answer),
  };
}
