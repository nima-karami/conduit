import { fileURLToPath } from 'node:url';
import { createDragDownloadGate } from '../src/drag-download-gate';
import type { HostPlatform } from '../src/lsp-binary';
import {
  decodeClipboardStdin,
  type OsClipboardPayload,
  osClipboardPayload,
} from '../src/os-clipboard-payload';
import type { DragOutRefusal, OutgoingFolders, OutgoingVerdict } from '../src/outgoing-paths';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import type { OsFileClipboard } from './os-file-clipboard';

export interface ClipboardLogEntry {
  payload: OsClipboardPayload;
  stdinPaths?: string[];
}
export type DownloadLogEntry =
  | { kind: 'arm'; path: unknown; accepted: boolean; reason?: DragOutRefusal }
  | { kind: 'download'; url: string; allowed: boolean };
export interface DragOutProbes {
  clipboard: ClipboardLogEntry[];
  download: DownloadLogEntry[];
}
export interface DragOutRequestCtx {
  senderContentsId: number;
  reply: (msg: HostToWebview) => void;
}
export interface DragOutHostDeps {
  platform: HostPlatform;
  e2e: boolean;
  systemRoot: string | undefined;
  /** The app window whose MAIN webContents has this id; undefined for guests / unknown. */
  appWindowIdFor(contentsId: number): number | undefined;
  /** undefined when the session is unknown or not owned by windowId. */
  sessionFolders(sessionId: string, windowId: number): OutgoingFolders | undefined;
  validate(paths: unknown, folders: OutgoingFolders): OutgoingVerdict;
  clipboard: OsFileClipboard;
  /** e2e only: main.ts sets globalThis.__conduitClipboardLog / __conduitDownloadLog to these. */
  installProbes(p: DragOutProbes): void;
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void;
  /** The folders of every session this window owns: a drag-download names no session. */
  windowFolders(windowId: number): OutgoingFolders;
  isDirectory(p: string): boolean;
  /** realPathLeaf semantics. */
  realpath(p: string): string;
  now(): number;
}
export interface DragOutHost {
  copyToOsClipboard(
    m: Extract<WebviewToHost, { type: 'fs:copyToOsClipboard' }>,
    ctx: DragOutRequestCtx,
  ): Promise<void>;
  /** Records the file a window's DownloadURL dragstart names, once it validates. */
  armDragDownload(
    m: Extract<WebviewToHost, { type: 'fs:armDragDownload' }>,
    senderContentsId: number,
  ): void;
  /** For will-download: true for any non-file: URL; a file: URL must spend a fresh grant armed
   *  by the same app window for the same real file. */
  allowDownload(url: string, contentsId: number): boolean;
}

/** The one host owner of drag-out and the OS file clipboard (os-drag-out plan, L12 S1). */
export function createDragOutHost(deps: DragOutHostDeps): DragOutHost {
  const probes: DragOutProbes = { clipboard: [], download: [] };
  if (deps.e2e) deps.installProbes(probes);
  const gate = createDragDownloadGate({ caseInsensitive: deps.platform === 'win32' });
  const record = (entry: DownloadLogEntry) => {
    if (deps.e2e) probes.download.push(entry);
  };
  const refuseArm = (path: unknown, reason: DragOutRefusal) => {
    deps.log('warn', 'drag-download arm refused', { reason, path });
    record({ kind: 'arm', path, accepted: false, reason });
  };
  const decideFileDownload = (url: string, contentsId: number): boolean => {
    const windowId = deps.appWindowIdFor(contentsId);
    if (windowId === undefined) return false;
    let p: string;
    try {
      p = fileURLToPath(url);
    } catch {
      return false;
    }
    return gate.claim(windowId, deps.realpath(p), deps.now());
  };

  return {
    async copyToOsClipboard(m, ctx) {
      const windowId = deps.appWindowIdFor(ctx.senderContentsId);
      if (windowId === undefined) {
        deps.log('warn', 'os clipboard from non-app sender', { contentsId: ctx.senderContentsId });
        return;
      }
      if (typeof m.requestId !== 'number') {
        deps.log('warn', 'os clipboard without a requestId', { requestId: m.requestId });
        return;
      }
      const requestId = m.requestId;
      const fail = (
        reason: Extract<HostToWebview, { type: 'fs:osClipboardResult'; ok: false }>['reason'],
        extra: { path?: string; detail?: string } = {},
      ) => ctx.reply({ type: 'fs:osClipboardResult', requestId, ok: false, reason, ...extra });

      const folders = deps.sessionFolders(m.sessionId, windowId);
      if (!folders) return fail('unknown-session');
      const verdict = deps.validate(m.paths, folders);
      if (!verdict.ok) {
        deps.log('warn', 'os clipboard refused', { reason: verdict.reason, path: verdict.path });
        return fail(verdict.reason, verdict.path !== undefined ? { path: verdict.path } : {});
      }
      const payload = osClipboardPayload(verdict.paths, deps.platform, deps.systemRoot);
      if (payload.kind === 'unsupported') {
        deps.log('info', 'os clipboard unsupported', { platform: deps.platform });
        return fail('unsupported');
      }
      if (payload.kind === 'unavailable') return fail('failed', { detail: payload.detail });
      if (deps.e2e) {
        probes.clipboard.push(
          payload.kind === 'powershell'
            ? { payload, stdinPaths: decodeClipboardStdin(payload.spawn.stdin) }
            : { payload },
        );
        ctx.reply({ type: 'fs:osClipboardResult', requestId, ok: true });
        return;
      }
      const r = await deps.clipboard.execute(payload);
      if (r.ok) {
        ctx.reply({ type: 'fs:osClipboardResult', requestId, ok: true });
        return;
      }
      // A newer Copy replaced this write before it ran; the renderer ignores the stale reply.
      if (r.detail === 'superseded') deps.log('info', 'os clipboard write superseded');
      else deps.log('warn', 'os clipboard write failed', { detail: r.detail });
      fail('failed', { detail: r.detail });
    },

    armDragDownload(m, senderContentsId) {
      const windowId = deps.appWindowIdFor(senderContentsId);
      if (windowId === undefined) {
        deps.log('warn', 'drag-download arm from non-app sender', { contentsId: senderContentsId });
        return;
      }
      if (typeof m.path !== 'string') {
        deps.log('warn', 'drag-download arm without a path');
        return;
      }
      const verdict = deps.validate([m.path], deps.windowFolders(windowId));
      if (!verdict.ok) return refuseArm(verdict.path ?? m.path, verdict.reason);
      const [p] = verdict.paths;
      if (deps.isDirectory(p)) return refuseArm(p, 'bad-request');
      gate.arm(windowId, deps.realpath(p), deps.now());
      record({ kind: 'arm', path: p, accepted: true });
    },

    allowDownload(url, contentsId) {
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        protocol = '';
      }
      if (protocol && protocol !== 'file:') return true;
      const allowed = protocol === 'file:' && decideFileDownload(url, contentsId);
      if (!allowed) deps.log('warn', 'drag-download refused', { url });
      record({ kind: 'download', url, allowed });
      return allowed;
    },
  };
}
