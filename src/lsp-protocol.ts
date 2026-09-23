// Renderer ↔ host language-server channel. Renderer-safe: no `vscode-*` import may land here
// (plan "Global constraints"). See docs/specs/2026-09-22-language-server-go.md §3.2.
import type { NavTreeNode } from './breadcrumbs';
import { hasDotSegment } from './canonical-path';

export type LspServerState =
  | 'absent'
  | 'starting'
  | 'loading'
  | 'ready'
  | 'restarting'
  | 'crashed'
  | 'stopped'
  // The folder is not trusted: no server may start (docs/specs/2026-09-23-workspace-trust.md).
  | 'restricted';
export type LspDocState = LspServerState | 'no-root';
export type LspOp =
  | 'definition'
  | 'typeDefinition'
  | 'implementation'
  | 'references'
  | 'hover'
  | 'documentSymbol';
/** 0-based line, UTF-16 character. */
export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export type LspUnavailableReason =
  | 'missing'
  | 'crashed'
  | 'no-root'
  | 'root-escapes'
  | 'restricted'
  | 'loading-timeout'
  | 'timeout'
  | 'server-error';
export type LspReply =
  | {
      kind: 'locations';
      locations: { path: string; range: LspRange }[];
      targets: { path: string; text: string }[];
      dropped: number;
    }
  | { kind: 'hover'; markdown: string; range?: LspRange }
  | { kind: 'symbols'; tree: NavTreeNode }
  | { kind: 'empty'; adHocRoot: boolean }
  | { kind: 'stale' }
  | { kind: 'unavailable'; reason: LspUnavailableReason; detail?: string };
export interface LspServerStatus {
  serverKey: string;
  languageId: string;
  root: string;
  state: LspServerState;
  progress?: string;
  pid: number | null;
}
/** What the renderer may know about a registry entry — all user-facing copy is templated from it. */
export interface LspLanguageInfo {
  languageId: string;
  displayName: string;
  binary: string;
  installHint: string;
  moduleMarker: string;
}
/** A host-raised Workspace Trust question. Answered by `id` only — the renderer never names the
 *  folder it trusts (docs/specs/2026-09-23-workspace-trust.md §4). */
export interface LspTrustPrompt {
  id: string;
  folder: string;
  parent: string | null;
  languageId: string;
  displayName: string;
  /** e.g. "gopls, go list" — the prompt's why line names them. */
  runsTools: string;
}
export type LspTrustChoice = 'trust' | 'trustParent' | 'deny';
export interface LspTrustState {
  trusted: string[];
  prompt: LspTrustPrompt | null;
}
export interface LspCalls {
  'lsp:open': {
    req: { path: string; languageId: string; version: number; text: string };
    res: { serverKey: string | null; state: LspDocState };
  };
  'lsp:change': { req: { path: string; version: number; text: string }; res: { ok: boolean } };
  'lsp:close': { req: { path: string }; res: { ok: boolean } };
  'lsp:request': {
    req: {
      requestId: string;
      path: string;
      version: number;
      op: LspOp;
      line: number;
      character: number;
    };
    res: LspReply;
  };
  'lsp:cancel': { req: { requestId: string }; res: { ok: boolean } };
  'lsp:statusSnapshot': {
    req: Record<never, never>;
    res: { servers: LspServerStatus[]; languages: LspLanguageInfo[] };
  };
  'lsp:restart': { req: { languageId: string }; res: { ok: boolean } };
  'lsp:trustState': { req: Record<never, never>; res: LspTrustState };
  /** Ask the host to raise the trust prompt for the folder holding `path`. */
  'lsp:trustRequest': { req: { path: string; languageId: string }; res: { ok: boolean } };
  'lsp:trustAnswer': { req: { promptId: string; choice: LspTrustChoice }; res: { ok: boolean } };
  'lsp:trustRevoke': { req: { path: string }; res: { ok: boolean } };
}
export type LspCallType = keyof LspCalls;
export type LspMessage<K extends LspCallType = LspCallType> = K extends LspCallType
  ? { type: K } & LspCalls[K]['req']
  : never;
export type LspResult<K extends LspCallType> = LspCalls[K]['res'];
/** What the preload actually sends over 'lsp'. */
export interface LspEnvelope {
  epoch: string;
  msg: LspMessage;
}

const OPS: ReadonlySet<string> = new Set<LspOp>([
  'definition',
  'typeDefinition',
  'implementation',
  'references',
  'hover',
  'documentSymbol',
]);
const CHOICES: ReadonlySet<string> = new Set<LspTrustChoice>(['trust', 'trustParent', 'deny']);
const ABSOLUTE = /^(\/|[a-zA-Z]:[\\/]|\\\\)/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = Number.POSITIVE_INFINITY): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** The host roots a spawned server at these paths, so none with a `.`/`..` segment is admitted. */
const absPath = (v: unknown): v is string => str(v) && ABSOLUTE.test(v) && !hasDotSegment(v);

/** Trust boundary: everything arriving over 'lsp' is renderer-controlled. Copies only the
 *  known fields so nothing extra rides along into the manager. */
export function parseLspMessage(raw: unknown): LspMessage | null {
  if (!isRec(raw)) return null;
  const r = raw;
  switch (r.type) {
    case 'lsp:open':
      return absPath(r.path) &&
        str(r.languageId, 32) &&
        count(r.version) &&
        typeof r.text === 'string'
        ? { type: r.type, path: r.path, languageId: r.languageId, version: r.version, text: r.text }
        : null;
    case 'lsp:change':
      return absPath(r.path) && count(r.version) && typeof r.text === 'string'
        ? { type: r.type, path: r.path, version: r.version, text: r.text }
        : null;
    case 'lsp:close':
      return absPath(r.path) ? { type: r.type, path: r.path } : null;
    case 'lsp:request':
      return str(r.requestId, 64) &&
        absPath(r.path) &&
        count(r.version) &&
        typeof r.op === 'string' &&
        OPS.has(r.op) &&
        count(r.line) &&
        count(r.character)
        ? {
            type: r.type,
            requestId: r.requestId,
            path: r.path,
            version: r.version,
            op: r.op as LspOp,
            line: r.line,
            character: r.character,
          }
        : null;
    case 'lsp:cancel':
      return str(r.requestId, 64) ? { type: r.type, requestId: r.requestId } : null;
    case 'lsp:statusSnapshot':
      return { type: r.type };
    case 'lsp:restart':
      return str(r.languageId, 32) ? { type: r.type, languageId: r.languageId } : null;
    case 'lsp:trustState':
      return { type: r.type };
    case 'lsp:trustRequest':
      return absPath(r.path) && str(r.languageId, 32)
        ? { type: r.type, path: r.path, languageId: r.languageId }
        : null;
    case 'lsp:trustAnswer':
      return str(r.promptId, 64) && typeof r.choice === 'string' && CHOICES.has(r.choice)
        ? { type: r.type, promptId: r.promptId, choice: r.choice as LspTrustChoice }
        : null;
    case 'lsp:trustRevoke':
      return absPath(r.path) ? { type: r.type, path: r.path } : null;
    default:
      return null;
  }
}

export function parseLspEnvelope(raw: unknown): LspEnvelope | null {
  if (!isRec(raw) || !str(raw.epoch, 64)) return null;
  const msg = parseLspMessage(raw.msg);
  return msg ? { epoch: raw.epoch, msg } : null;
}
