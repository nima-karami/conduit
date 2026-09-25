import type { HostPlatform } from '../src/lsp-binary';
import {
  decodeClipboardStdin,
  type OsClipboardPayload,
  osClipboardPayload,
} from '../src/os-clipboard-payload';
import type { OutgoingFolders, OutgoingVerdict } from '../src/outgoing-paths';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import type { OsFileClipboard } from './os-file-clipboard';

export interface ClipboardLogEntry {
  payload: OsClipboardPayload;
  stdinPaths?: string[];
}
export interface DragOutProbes {
  clipboard: ClipboardLogEntry[];
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
  /** e2e only: main.ts sets globalThis.__conduitClipboardLog to this array. */
  installProbes(p: DragOutProbes): void;
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void;
}
export interface DragOutHost {
  copyToOsClipboard(
    m: Extract<WebviewToHost, { type: 'fs:copyToOsClipboard' }>,
    ctx: DragOutRequestCtx,
  ): Promise<void>;
}

/** The one host owner of drag-out and the OS file clipboard (os-drag-out plan, L12 S1). */
export function createDragOutHost(deps: DragOutHostDeps): DragOutHost {
  const probes: DragOutProbes = { clipboard: [] };
  if (deps.e2e) deps.installProbes(probes);

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
  };
}
