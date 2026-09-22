// The language-server half of a navigation: the probe `runNavCommand` swaps in for a language
// with a server, the guard that makes a late reply harmless, and the peek models its targets
// need. Landing and peeking stay `runNavCommand`'s (spec 2026-09-22-language-server-go §2.1).
import * as monaco from 'monaco-editor';
import { langFromPath } from '../src/lang';
import type { LspLanguageInfo, LspOp, LspRange } from '../src/lsp-protocol';
import { lspInvoke } from './bridge';
import { currentVersion, flushPending, isLspDocOpen, lspRequest } from './lsp-sync';
import { ensureTokenizer } from './monaco-languages';
import type { NavCommandKind, NavMessage } from './nav-outcome';
import { fileUri, pathForUri } from './project-index';

export interface LspNavProbe {
  locations: monaco.languages.Location[];
  timedOut: boolean;
  unavailable: 'missing' | 'crashed' | 'no-root' | 'loading-timeout' | null;
  adHocRoot: boolean;
  cancelled: boolean;
}

export interface LspNavGuard {
  readonly cancelled: boolean;
  readonly requestId: string;
  dispose(): void;
}

const EMPTY_PROBE: LspNavProbe = {
  locations: [],
  timedOut: false,
  unavailable: null,
  adHocRoot: false,
  cancelled: false,
};

let active: { cancel(): void } | null = null;
/** Peek-preview models the previous navigation created. Monaco has no peek-close event, so they
 *  live until the next navigation or the editor's disposal (plan Decisions Needed). */
let peekModels: monaco.editor.ITextModel[] = [];
let seq = 0;

function disposePeekModels(): void {
  for (const m of peekModels) if (!m.isDisposed() && !isLspDocOpen(pathForUri(m.uri))) m.dispose();
  peekModels = [];
}

export function beginLspNav(editor: monaco.editor.ICodeEditor): LspNavGuard {
  active?.cancel();
  disposePeekModels();
  // Ctrl+click moves the caret to the click BEFORE the navigation starts; only a move away from
  // where this navigation began is the user changing their mind (plan finding #9).
  const origin = editor.getPosition();
  const requestId = `nav-${++seq}-${Date.now().toString(36)}`;
  let cancelled = false;
  let subs: monaco.IDisposable[] = [];
  const release = () => {
    for (const s of subs) s.dispose();
    subs = [];
    if (active === handle) active = null;
  };
  const handle = {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      release();
      void lspInvoke({ type: 'lsp:cancel', requestId });
    },
  };
  subs = [
    editor.onDidChangeCursorPosition((e) => {
      const p = e.position;
      if (!origin || p.lineNumber !== origin.lineNumber || p.column !== origin.column) {
        handle.cancel();
      }
    }),
    editor.onDidChangeModel(() => handle.cancel()),
    editor.onDidChangeModelContent(() => handle.cancel()),
    editor.onDidDispose(() => {
      handle.cancel();
      disposePeekModels();
    }),
  ];
  active = handle;
  return {
    get cancelled() {
      return cancelled;
    },
    requestId,
    dispose: release,
  };
}

function lspToMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function modelForTarget(path: string, text: string): monaco.editor.ITextModel {
  const uri = fileUri(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  const language = langFromPath(path);
  ensureTokenizer(language);
  const model = monaco.editor.createModel(text, language, uri);
  peekModels.push(model);
  return model;
}

export async function probeLspNav(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  kind: NavCommandKind,
  guard: LspNavGuard,
): Promise<LspNavProbe> {
  const path = pathForUri(model.uri);
  await flushPending(path);
  if (guard.cancelled) return { ...EMPTY_PROBE, cancelled: true };
  const op: LspOp = kind === 'peek' ? 'definition' : kind;
  const reply = await lspRequest(
    path,
    op,
    { line: position.lineNumber - 1, character: position.column - 1 },
    guard.requestId,
  );
  if (guard.cancelled || reply.kind === 'stale') return { ...EMPTY_PROBE, cancelled: true };
  if (reply.kind === 'unavailable') {
    return reply.reason === 'timeout' || reply.reason === 'server-error'
      ? { ...EMPTY_PROBE, timedOut: true }
      : { ...EMPTY_PROBE, unavailable: reply.reason };
  }
  if (reply.kind === 'empty') return { ...EMPTY_PROBE, adHocRoot: reply.adHocRoot };
  if (reply.kind !== 'locations') return EMPTY_PROBE;
  const held = new Set<string>();
  for (const t of reply.targets) held.add(modelForTarget(t.path, t.text).uri.toString());
  const locations: monaco.languages.Location[] = [];
  for (const l of reply.locations) {
    const uri = fileUri(l.path);
    // A target we hold no content for is dropped, as the TS path drops one (ts-nav toLocations).
    if (!held.has(uri.toString()) && !monaco.editor.getModel(uri) && !isLspDocOpen(l.path))
      continue;
    locations.push({ uri, range: lspToMonacoRange(l.range) });
  }
  return { ...EMPTY_PROBE, locations };
}

export function lspLoadingMessage(language: LspLanguageInfo): NavMessage {
  return {
    text: `${language.displayName}: loading workspace…`,
    channel: 'inline',
    variant: 'info',
  };
}

/**
 * One hover provider per server language. Hover flushes the pending edit first — ≤ 150 ms of
 * typing must never be answered against text the user can no longer see (plan finding #11).
 * Only a synced tab is asked: a peek preview's model is not a doc the host holds.
 */
export function registerLspHoverProvider(languageIds: readonly string[]): monaco.IDisposable {
  const providers = languageIds.map((languageId) =>
    monaco.languages.registerHoverProvider(languageId, {
      provideHover: async (model, position, token) => {
        const path = pathForUri(model.uri);
        if (!isLspDocOpen(path)) return null;
        await flushPending(path);
        if (token.isCancellationRequested) return null;
        const version = currentVersion(path);
        const requestId = `hover-${++seq}-${Date.now().toString(36)}`;
        const onCancel = token.onCancellationRequested(() => {
          void lspInvoke({ type: 'lsp:cancel', requestId });
        });
        try {
          const reply = await lspRequest(
            path,
            'hover',
            { line: position.lineNumber - 1, character: position.column - 1 },
            requestId,
          );
          if (reply.kind !== 'hover' || token.isCancellationRequested) return null;
          if (currentVersion(path) !== version) return null;
          return {
            contents: [{ value: reply.markdown, isTrusted: false }],
            ...(reply.range ? { range: lspToMonacoRange(reply.range) } : {}),
          };
        } finally {
          onCancel.dispose();
        }
      },
    }),
  );
  return {
    dispose: () => {
      for (const p of providers) p.dispose();
    },
  };
}
