/**
 * What a code navigation actually did, and the one sentence the user gets to read about it.
 *
 * Monaco-free on purpose (same split as `ts-index-state.ts` vs `ts-project.ts`) so the rules
 * and the copy are unit-testable in the node env, and so `webview/ts-nav.ts` is left with
 * nothing but the editor plumbing.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md contract 3 (and contract 5 for the
 * cap/skip facts the message admits to).
 */

import { INDEX_MAX_FILE_BYTES } from '../src/source-index';

export type NavOutcome =
  | { kind: 'navigated' }
  | { kind: 'peeked' }
  | { kind: 'resolving'; specifier: string; fromFile: string }
  | { kind: 'none' }
  | { kind: 'unsupported' }
  | { kind: 'timed-out' };

export type NavCommandKind =
  | 'definition'
  | 'typeDefinition'
  | 'implementation'
  | 'references'
  | 'peek';

const COMMAND_KINDS: Record<string, NavCommandKind> = {
  'editor.action.revealDefinition': 'definition',
  'editor.action.goToTypeDefinition': 'typeDefinition',
  'editor.action.goToImplementation': 'implementation',
  'editor.action.goToReferences': 'references',
  'editor.action.referenceSearch.trigger': 'references',
  'editor.action.peekDefinition': 'peek',
};

export function navCommandKind(commandId: string): NavCommandKind | null {
  return COMMAND_KINDS[commandId] ?? null;
}

export interface NavClassifyInput {
  kind: NavCommandKind;
  /** Locations the provider produced, AFTER dropping targets we hold no content for. */
  resultCount: number;
  /** The sole result is an import alias whose own module is unresolved — the import the
   *  symbol came through. True for the importing file itself AND for a barrel in another
   *  file. */
  soleResultIsUnresolvedAlias: boolean;
  /** The unresolved module specifier behind the cursor, when one was found. */
  unresolved: { specifier: string; fromFile: string } | null;
  /** `isIndexReady()`. Inert as a VERDICT — an empty result mid-stream is still honestly
   *  `none`; what the index state changes is the message, which `navOutcomeMessage` picks. */
  indexReady: boolean;
  /** Active model's language is TS/JS. */
  supported: boolean;
  /** The navigation blew its deadline. */
  timedOut: boolean;
}

export function classifyNavOutcome(input: NavClassifyInput): NavOutcome {
  if (!input.supported) return { kind: 'unsupported' };
  if (input.timedOut) return { kind: 'timed-out' };
  const { unresolved } = input;
  if (unresolved && (input.resultCount === 0 || input.soleResultIsUnresolvedAlias)) {
    return { kind: 'resolving', specifier: unresolved.specifier, fromFile: unresolved.fromFile };
  }
  if (input.kind === 'references' || input.kind === 'peek') {
    return input.resultCount > 0 ? { kind: 'peeked' } : { kind: 'none' };
  }
  if (input.resultCount === 0) return { kind: 'none' };
  if (input.resultCount === 1) return { kind: 'navigated' };
  return { kind: 'peeked' };
}

export interface NavMessageContext {
  kind: NavCommandKind;
  /** `model.getWordAtPosition(position)?.word ?? null`. */
  word: string | null;
  index: { loaded: number; total: number; done: boolean; skipped: number; capped: number };
}

export interface NavMessage {
  text: string;
  /** `inline` = at the cursor (Monaco's MessageController); `toast` = the global stack. */
  channel: 'inline' | 'toast';
  variant: 'info' | 'error';
}

const NOUNS: Record<NavCommandKind, string> = {
  definition: 'definition',
  peek: 'definition',
  typeDefinition: 'type definition',
  implementation: 'implementation',
  references: 'references',
};

function inline(text: string): NavMessage {
  return { text, channel: 'inline', variant: 'info' };
}

const MAX_FILE_MB = INDEX_MAX_FILE_BYTES / (1024 * 1024);

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/**
 * What the completed index knowingly does NOT hold, when there is anything to admit.
 *
 * Only appended once the index is done: while it is still streaming, "try again in a moment"
 * is both shorter and the better advice, and a cap the stream hasn't reached yet isn't why
 * this particular lookup missed.
 */
function indexGapNote(index: NavMessageContext['index']): string {
  const parts: string[] = [];
  if (index.capped > 0) parts.push(`${files(index.capped)} beyond the index cap`);
  if (index.skipped > 0) parts.push(`${files(index.skipped)} over ${MAX_FILE_MB} MB skipped`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** The FINAL message for an outcome; `null` when the outcome speaks for itself. */
export function navOutcomeMessage(o: NavOutcome, ctx: NavMessageContext): NavMessage | null {
  if (o.kind === 'navigated' || o.kind === 'peeked') return null;
  if (o.kind === 'unsupported') {
    return {
      text: 'Code navigation is only available for JS/TS files.',
      channel: 'toast',
      variant: 'info',
    };
  }
  if (o.kind === 'timed-out') {
    return { text: 'Couldn’t resolve in time. Try again.', channel: 'toast', variant: 'error' };
  }
  // A miss while the stream is still running is not a verdict about the code — and "it isn't
  // indexed" would be a lie about a file the index is on its way to delivering.
  if (!ctx.index.done) {
    const { loaded, total } = ctx.index;
    return inline(
      total
        ? `Still indexing this project (${loaded} of ${total} files). Try again in a moment.`
        : 'This project hasn’t been indexed yet — cross-file navigation is still warming up.',
    );
  }
  const gap = indexGapNote(ctx.index);
  if (o.kind === 'resolving')
    return inline(`Can’t navigate into '${o.specifier}' — it isn’t indexed${gap}`);
  return inline(
    `${ctx.word ? `No ${NOUNS[ctx.kind]} for '${ctx.word}' here` : 'Nothing to navigate to here'}${gap}`,
  );
}

/** The in-flight notice shown while an on-demand resolve is running. */
export function resolvingMessage(specifier: string): NavMessage {
  return inline(`Resolving '${specifier}'…`);
}

/** TS error codes that mean "this module specifier did not resolve". */
export const UNRESOLVED_MODULE_CODES: ReadonlySet<number> = new Set([2307, 7016, 2792]);

/** How many alias→barrel hops one navigation may chase before giving up honestly. */
export const NAV_HOP_CAP = 4;

export interface DiagnosticLike {
  code: number;
  start?: number;
  length?: number;
  messageText?: unknown;
}

export interface SpecifierSpan {
  specifier: string;
  start: number;
  length: number;
}

/** A module specifier is a single-line string literal — quoted, or the no-substitution
 *  template form a dynamic import can use. Anything else means the diagnostic spans were
 *  computed against a text we no longer hold. */
const QUOTED_LITERAL = /^(['"`])([^\r\n]+)\1$/;

/**
 * Unresolved-module specifier spans in one file, from its semantic diagnostics + its text.
 *
 * The specifier is read out of the SPAN, never out of `messageText`: that string is localized
 * and its quoting varies between TS versions.
 */
export function unresolvedSpecifierSpans(
  diagnostics: readonly DiagnosticLike[],
  text: string,
): SpecifierSpan[] {
  const out: SpecifierSpan[] = [];
  for (const d of diagnostics) {
    if (!UNRESOLVED_MODULE_CODES.has(d.code)) continue;
    const { start, length } = d;
    if (typeof start !== 'number' || typeof length !== 'number' || length <= 0) continue;
    const m = QUOTED_LITERAL.exec(text.slice(start, start + length));
    if (!m) continue;
    out.push({ specifier: m[2], start, length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The span containing `offset`, if any (cursor sitting on the specifier literal). */
export function specifierSpanAt(
  spans: readonly SpecifierSpan[],
  offset: number,
): SpecifierSpan | null {
  return spans.find((s) => offset >= s.start && offset <= s.start + s.length) ?? null;
}

/**
 * Where the import/export statement covering `offset` begins, or -1 if no statement head
 * precedes it.
 *
 * An import clause can span lines, so the alias→specifier walk cannot be bounded by the line —
 * and it cannot be bounded by punctuation either: a semicolon-free file has none to find, and
 * a comment between an alias and the next import would be walked straight across. The
 * statement HEAD is the only anchor that holds in both.
 */
function statementStartBefore(text: string, offset: number): number {
  const head = /^[ \t]*(?:import|export)\b/gm;
  let start = -1;
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    if (m.index > offset) break;
    start = m.index;
  }
  return start;
}

/**
 * The specifier an import ALIAS came through: the nearest unresolved span at or after the
 * alias, and only when the alias itself sits inside that span's own statement.
 */
export function specifierForAlias(
  alias: { start: number; length: number },
  spans: readonly SpecifierSpan[],
  text: string,
): SpecifierSpan | null {
  const aliasEnd = alias.start + alias.length;
  const span = [...spans].sort((a, b) => a.start - b.start).find((s) => s.start >= aliasEnd);
  if (!span) return null;
  const statement = statementStartBefore(text, span.start);
  return statement >= 0 && alias.start >= statement ? span : null;
}
