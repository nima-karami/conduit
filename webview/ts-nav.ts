/**
 * The navigation commands Monaco's TypeScript mode doesn't provide, plus the wrapper that
 * computes every navigation itself and reports exactly what happened.
 *
 * `tsMode.js` registers definition and reference providers but neither type-definition nor
 * implementation, so `editor.action.goToTypeDefinition` and `editor.action.goToImplementation`
 * have nothing to call. The providers below fill that in against the worker methods added in
 * `webview/ts.worker.ts`.
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §3d–§3e and
 * docs/specs/2026-08-21-goto-definition-flows.md contract 3.
 */

import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';
import type {
  TsDefinitionInfo,
  TsDiagnostic,
} from 'monaco-editor/esm/vs/language/typescript/tsWorker.js';
import { langFromPath } from '../src/lang';
import { withTimeout } from '../src/with-timeout';
import { executeCommandWithArgs } from './monaco-commands';
import { ensureTokenizer } from './monaco-languages';
import { showNavMessage } from './monaco-message';
import { gotoInflight } from './monaco-warmup';
import {
  classifyNavOutcome,
  NAV_HOP_CAP,
  type NavCommandKind,
  type NavOutcome,
  navCommandKind,
  navOutcomeMessage,
  resolvingMessage,
  specifierForAlias,
  specifierSpanAt,
  unresolvedSpecifierSpans,
} from './nav-outcome';
import { openDefinitionFile, pathForUri, setReveal } from './project-index';
import { indexStatus, isIndexReady } from './ts-project';

/** Language ids whose navigation is backed by the TS/JS worker. */
export const TS_LANGS = new Set(['typescript', 'javascript']);

/**
 * How long a navigation may run before we give up on it. Generous enough for a cold worker
 * building a program over a few thousand files, short enough that "Resolving definition…"
 * can never be a permanent fixture — which is exactly how this failed before.
 */
const NAV_TIMEOUT_MS = 6000;

const TIMED_OUT = Symbol('timed-out');

/** The methods `webview/ts.worker.ts` adds, plus the ones monaco's own worker has but
 *  publishes no type for (see types/monaco-internal.d.ts). */
interface ConduitWorker {
  getDefinitionAtPosition(f: string, p: number): Promise<TsDefinitionInfo[] | undefined>;
  getTypeDefinitionAtPosition(f: string, p: number): Promise<TsDefinitionInfo[] | undefined>;
  getImplementationAtPosition(f: string, p: number): Promise<TsDefinitionInfo[] | undefined>;
  getReferencesAtPosition(f: string, p: number): Promise<TsDefinitionInfo[] | undefined>;
  getSemanticDiagnostics(f: string): Promise<TsDiagnostic[]>;
}

async function workerFor(model: monaco.editor.ITextModel): Promise<ConduitWorker> {
  const getWorker =
    model.getLanguageId() === 'javascript'
      ? await monacoTs.getJavaScriptWorker()
      : await monacoTs.getTypeScriptWorker();
  // Crossing a worker boundary: the proxy carries our subclass's methods at runtime, but
  // monaco's published type describes only its own.
  return (await getWorker(model.uri)) as unknown as ConduitWorker;
}

type Lookup = (
  worker: ConduitWorker,
  fileName: string,
  offset: number,
) => Promise<TsDefinitionInfo[] | undefined>;

const LOOKUPS: Record<NavCommandKind, Lookup> = {
  definition: (w, f, o) => w.getDefinitionAtPosition(f, o),
  // A peek shows DEFINITIONS in a widget — same provider, different presentation.
  peek: (w, f, o) => w.getDefinitionAtPosition(f, o),
  typeDefinition: (w, f, o) => w.getTypeDefinitionAtPosition(f, o),
  implementation: (w, f, o) => w.getImplementationAtPosition(f, o),
  references: (w, f, o) => w.getReferencesAtPosition(f, o),
};

/**
 * Resolve a target file to a model so a span can be turned into a range. Mirrors what
 * Monaco's own adapters do via `LibFiles.getOrCreateModel`, except the model is created with
 * the file's REAL language rather than a hardcoded `typescript`.
 */
function targetModel(fileName: string): monaco.editor.ITextModel | null {
  const uri = monaco.Uri.parse(fileName);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  const lib = monacoTs.typescriptDefaults.getExtraLibs()[fileName];
  if (!lib) return null;
  const language = langFromPath(uri.path);
  ensureTokenizer(language);
  return monaco.editor.createModel(lib.content, language, uri);
}

/** The text of a file we may hold no model for. Unlike `targetModel` this never CREATES one —
 *  diagnosing a barrel must not materialise a model for it. */
function textOf(fileName: string): string | null {
  const existing = monaco.editor.getModel(monaco.Uri.parse(fileName));
  if (existing) return existing.getValue();
  return monacoTs.typescriptDefaults.getExtraLibs()[fileName]?.content ?? null;
}

function toLocations(entries: TsDefinitionInfo[] | undefined): monaco.languages.Location[] {
  const out: monaco.languages.Location[] = [];
  for (const entry of entries ?? []) {
    const model = targetModel(entry.fileName);
    // A target we hold no content for is dropped rather than opened as an empty tab; an
    // empty result then reports not-found (or still-indexing) through runNavCommand.
    if (!model) continue;
    const start = model.getPositionAt(entry.textSpan.start);
    const end = model.getPositionAt(entry.textSpan.start + entry.textSpan.length);
    out.push({
      uri: model.uri,
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
    });
  }
  return out;
}

async function provide(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  lookup: Lookup,
): Promise<monaco.languages.Location[] | undefined> {
  if (model.isDisposed()) return undefined;
  gotoInflight.begin();
  try {
    const worker = await workerFor(model);
    if (model.isDisposed()) return undefined;
    const entries = await withTimeout(
      lookup(worker, model.uri.toString(), model.getOffsetAt(position)),
      NAV_TIMEOUT_MS,
      undefined,
    );
    return model.isDisposed() ? undefined : toLocations(entries);
  } catch {
    return undefined;
  } finally {
    gotoInflight.end();
  }
}

/** Register the type-definition and implementation providers for TS and JS. */
export function registerTsNavigationProviders(): monaco.IDisposable[] {
  const disposables: monaco.IDisposable[] = [];
  for (const language of TS_LANGS) {
    disposables.push(
      monaco.languages.registerTypeDefinitionProvider(language, {
        provideTypeDefinition: (model, position) =>
          provide(model, position, LOOKUPS.typeDefinition),
      }),
      monaco.languages.registerImplementationProvider(language, {
        provideImplementation: (model, position) =>
          provide(model, position, LOOKUPS.implementation),
      }),
    );
  }
  return disposables;
}

// ── Measuring one navigation ────────────────────────────────────────────────────────────

interface NavProbe {
  entries: TsDefinitionInfo[];
  locations: monaco.languages.Location[];
  timedOut: boolean;
}

async function probeNav(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  kind: NavCommandKind,
): Promise<NavProbe> {
  let entries: TsDefinitionInfo[] = [];
  let timedOut = false;
  // Row 38: this call is not bound to Monaco's `EditorStateCancellationTokenSource`, so a
  // concurrent re-seed cannot cancel it — it can only make the answer stale. Re-ask once.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (model.isDisposed()) break;
    const version = model.getVersionId();
    const worker = await workerFor(model);
    const result = await withTimeout<TsDefinitionInfo[] | undefined | typeof TIMED_OUT>(
      LOOKUPS[kind](worker, model.uri.toString(), model.getOffsetAt(position)),
      NAV_TIMEOUT_MS,
      TIMED_OUT,
    );
    if (result === TIMED_OUT) {
      timedOut = true;
      break;
    }
    entries = result ?? [];
    if (model.isDisposed() || model.getVersionId() === version) break;
  }
  return { entries, locations: toLocations(entries), timedOut };
}

/** The word under the cursor as a span, so a zero-result miss can still be walked forward to
 *  the import it came through when the cursor sits on the local name. */
function wordSpan(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): { start: number; length: number } {
  const word = model.getWordAtPosition(position);
  if (!word) return { start: model.getOffsetAt(position), length: 0 };
  const start = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
  return { start, length: word.word.length };
}

interface MissProbe {
  unresolved: { specifier: string; fromFile: string } | null;
  timedOut: boolean;
}

const NO_MISS: MissProbe = { unresolved: null, timedOut: false };

/**
 * How long the miss-probe's type-check may run. Much shorter than `NAV_TIMEOUT_MS`, because
 * this runs BEFORE the caret is allowed to move: a lone import alias is not navigated to until
 * we know whether its module resolved, so the user waits out this deadline on every such
 * navigation — including the ones that end up succeeding.
 */
const DIAGNOSTICS_TIMEOUT_MS = 1500;

/**
 * The module specifier behind a miss, when there is one.
 *
 * `getSemanticDiagnostics` type-checks the file against the whole program, so it runs ONLY on
 * a miss (zero locations, or a lone import alias) — never on the happy path.
 *
 * A timeout is reported as such, NEVER as "nothing unresolved": those two are opposite
 * verdicts, and collapsing them lets a lone alias degrade back into a navigation onto its own
 * import clause — the silent wrong jump this spec exists to remove.
 */
async function unresolvedFor(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  entries: TsDefinitionInfo[],
): Promise<MissProbe> {
  const sole = entries.length === 1 && entries[0].kind === 'alias' ? entries[0] : null;
  // A sole alias may live in a BARREL rather than in the file on screen, so diagnose whichever
  // file actually holds the import.
  const fileName = sole ? sole.fileName : model.uri.toString();
  const text = textOf(fileName);
  if (text === null) return NO_MISS;
  const worker = await workerFor(model);
  // With `checkJs` off a .js file gets no 2307/7016 at all, so this finds nothing there; a
  // resolver has to trigger off its OWN miss for those. See the row 19b note in
  // .autoloop/evidence/nav-outcome-e2e.txt.
  const diagnostics = await withTimeout<TsDiagnostic[] | null>(
    worker.getSemanticDiagnostics(fileName),
    DIAGNOSTICS_TIMEOUT_MS,
    null,
  );
  if (diagnostics === null) return { unresolved: null, timedOut: true };
  const spans = unresolvedSpecifierSpans(diagnostics, text);
  if (!spans.length) return NO_MISS;
  const span = sole
    ? specifierForAlias(sole.textSpan, spans, text)
    : (specifierSpanAt(spans, model.getOffsetAt(position)) ??
      specifierForAlias(wordSpan(model, position), spans, text));
  return span
    ? { unresolved: { specifier: span.specifier, fromFile: fileName }, timedOut: false }
    : NO_MISS;
}

// ── Acting on the outcome ───────────────────────────────────────────────────────────────

function openLocation(editor: monaco.editor.ICodeEditor, loc: monaco.languages.Location): void {
  const current = editor.getModel()?.uri;
  const target = { lineNumber: loc.range.startLineNumber, column: loc.range.startColumn };
  if (current && current.toString() === loc.uri.toString()) {
    editor.setPosition(target);
    editor.revealRangeInCenter(loc.range);
    editor.focus();
    return;
  }
  // Our own opener path — the same one registerEditorOpener drives (webview/monaco-opener.ts).
  // Going through it directly makes a single-result navigation immune to the built-in
  // command's silent early returns; see docs/specs/2026-08-21-goto-definition-flows.md §3.
  const abs = pathForUri(loc.uri);
  setReveal(abs, { line: target.lineNumber, column: target.column });
  openDefinitionFile(abs);
}

/**
 * Hand OUR locations to Monaco's peek command rather than re-dispatching the provider-gated
 * action: same peek widget / picker / references pane, no `hasDefinitionProvider` precondition
 * (row 39) and no second worker round-trip.
 *
 * ALWAYS `peekLocations`, never `goToLocations`. For two or more results the two are identical
 * — `multiple: 'peek'` is every `gotoLocation.multiple*` option's default, so both land in the
 * widget. They differ at exactly one result, where `goToLocations` NAVIGATES: for Go to
 * References on a symbol with a single reference, that means moving the caret to where it
 * already is, so a `peeked` outcome would have reported something the user cannot see.
 */
async function dispatchLocations(
  editor: monaco.editor.ICodeEditor,
  locations: monaco.languages.Location[],
): Promise<void> {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position || !locations.length) return;
  await executeCommandWithArgs(
    'editor.action.peekLocations',
    model.uri,
    position,
    locations,
    'peek',
  );
}

/** Monaco runs `gotoLocation.alternativeDefinitionCommand` (default: Go to References) when the
 *  sole result CONTAINS the cursor — "you are already there". These are the two kinds whose
 *  alternative is non-empty by default; implementation and references default to `''`. */
const HAS_REFERENCE_ALTERNATIVE = new Set<NavCommandKind>(['definition', 'typeDefinition']);

function atCursor(
  locations: monaco.languages.Location[],
  uri: monaco.Uri,
  position: monaco.Position,
): boolean {
  return locations.some(
    (l) =>
      l.uri.toString() === uri.toString() && monaco.Range.lift(l.range).containsPosition(position),
  );
}

// ── The wrapper ─────────────────────────────────────────────────────────────────────────

export interface NavDeps {
  /** Returns whether the caller pushed new content and the navigation is worth retrying.
   *  Nothing supplies it yet; docs/plans/2026-08-21-resolve-on-demand.plan.md wires it. */
  onUnresolved?: (fromFile: string, specifier: string) => Promise<boolean>;
}

/**
 * Run a navigation and report exactly one classified outcome.
 *
 * The wrapper asks the TS worker itself instead of dispatching a provider-gated built-in and
 * inferring success from "did the editor move" — that heuristic read a caret landing on the
 * import clause of an unresolved module as a success, which is the silent wrong jump the
 * spec's baseline recorded. See docs/specs/2026-08-21-goto-definition-flows.md contract 3.
 */
export async function runNavCommand(
  editor: monaco.editor.ICodeEditor,
  commandId: string,
  deps: NavDeps = {},
): Promise<NavOutcome> {
  // These commands resolve their target from the FOCUSED editor, so a menu click (which
  // moved focus to the menu) has to hand it back first.
  editor.focus();
  const model = editor.getModel();
  const position = editor.getPosition();
  const requested = navCommandKind(commandId);
  if (!model || !position || !requested) return { kind: 'none' };

  const supported = TS_LANGS.has(model.getLanguageId());
  let kind = requested;
  let alternative = false;
  gotoInflight.begin();
  try {
    let outcome: NavOutcome = { kind: 'none' };
    let probe: NavProbe | null = null;
    for (let hop = 0; hop <= NAV_HOP_CAP; hop++) {
      if (!supported) {
        outcome = { kind: 'unsupported' };
        break;
      }
      probe = await probeNav(model, position, kind);
      if (
        !alternative &&
        HAS_REFERENCE_ALTERNATIVE.has(kind) &&
        probe.locations.length === 1 &&
        atCursor(probe.locations, model.uri, position)
      ) {
        alternative = true;
        kind = 'references';
        probe = await probeNav(model, position, kind);
      }
      const entries = probe.entries;
      const soleAlias = entries.length === 1 && entries[0].kind === 'alias';
      const miss =
        probe.locations.length === 0 || soleAlias
          ? await unresolvedFor(model, position, entries)
          : NO_MISS;
      outcome = classifyNavOutcome({
        kind,
        resultCount: probe.locations.length,
        soleResultIsUnresolvedAlias: soleAlias && miss.unresolved !== null,
        unresolved: miss.unresolved,
        indexReady: isIndexReady(),
        supported,
        timedOut: probe.timedOut || miss.timedOut,
      });
      if (outcome.kind !== 'resolving' || hop === NAV_HOP_CAP) break;
      const resolve = deps.onUnresolved;
      if (!resolve) break; // nobody is listening yet — report honestly instead
      showNavMessage(editor, resolvingMessage(outcome.specifier));
      if (!(await resolve(outcome.fromFile, outcome.specifier))) break;
    }
    if (probe && outcome.kind === 'navigated') openLocation(editor, probe.locations[0]);
    else if (probe && outcome.kind === 'peeked') await dispatchLocations(editor, probe.locations);
    // The message names what the USER asked for, not the kind the alternative hop switched to:
    // a Go to Definition that finds nothing says "No definition…", never "No references…".
    const message = navOutcomeMessage(outcome, {
      kind: requested,
      word: model.getWordAtPosition(position)?.word ?? null,
      index: indexStatus(),
    });
    if (message) showNavMessage(editor, message);
    return outcome;
  } catch {
    // Callers `void` this promise, so an escaping rejection is silence — the exact failure the
    // spec exists to remove. Reachable: tsMode rejects with a bare STRING ("TypeScript not
    // registered!") until it is set up, which is row 39's window; a model or editor disposed
    // mid-flight; a command service that refuses. Nothing is known about the result at this
    // point, so the honest report is the one that claims nothing about the code.
    const outcome: NavOutcome = { kind: 'timed-out' };
    const message = navOutcomeMessage(outcome, {
      kind: requested,
      word: null,
      index: indexStatus(),
    });
    if (message) showNavMessage(editor, message);
    return outcome;
  } finally {
    gotoInflight.end();
  }
}
