# Navigation Outcome — Explicit, Honest, Classified Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every code navigation ends in exactly one classified, visible outcome —
`navigated | peeked | resolving | none | unsupported | timed-out` — computed from the
provider result Conduit itself asked for, never inferred from "did the editor move", and
never voiced by Monaco ("No definition found for 'zod'" is factually wrong for something
that merely isn't indexed).

**Architecture:** A new pure module `webview/nav-outcome.ts` owns the classification and
*all* the copy (monaco-free, so it unit-tests in the node env — same split as
`ts-index-state.ts` vs `ts-project.ts`). `webview/ts-nav.ts`'s `runNavCommand` stops being a
"dispatch and guess" wrapper: it calls the TS worker itself
(`getDefinitionAtPosition` / our `getTypeDefinitionAtPosition` / `getImplementationAtPosition`
/ `getReferencesAtPosition`), maps entries through the existing `toLocations`, classifies, and
then acts — opening a single result through *our* opener path (`setReveal` +
`openDefinitionFile`, exactly what `webview/monaco-opener.ts` does), or dispatching Monaco's
built-in command only when the peek/picker UX is what's wanted (≥2 results, or a
references/peek command). Zero results trigger an explicit `getSemanticDiagnostics` call to
find the unresolved module specifier behind the cursor — diagnostics stay OFF in the UI; this
is a one-shot query, not a mode. The `resolving` outcome calls an injectable
`onUnresolved` hook that stays unregistered in this plan (Plan B registers it) and reports an
honest message either way. The `moved` heuristic and the `openedCount` counter that fed it
are deleted.

**Tech Stack:** TypeScript, monaco-editor (standalone), a subclassed TS web worker
(`webview/ts.worker.ts`), vitest (`test/unit/`), Playwright-Electron e2e
(`test/e2e/harness.mjs`).

**Spec:** `docs/specs/2026-08-21-goto-definition-flows.md` — contract §3; flow rows 12, 13,
37, 38, 39, 40, 45.

**Depends on:** the fixture matrix task (`test/e2e/fixtures/goto/build-fixture.mjs` +
`test/e2e/goto-matrix*.e2e.mjs`) landing on `main` first. Tasks 1–4 do not need it; Task 5 does.

## Global Constraints

- `npm run verify` must stay fully green; never weaken/narrow/disable any gate. `fallow:check`
  fails on **dead code** — deleting the `moved` heuristic strands `openedCount`/`openCount` in
  `webview/monaco-opener.ts`, so they must be deleted in the same commit (Task 3).
- Comments: WHY only; link the spec (`// see docs/specs/2026-08-21-goto-definition-flows.md §3`),
  never restate it. Hard repo rule (CLAUDE.md).
- Two tsconfigs (host + webview): `npm run typecheck` runs both. `webview/nav-outcome.ts` must
  stay monaco-free and node-importable (it is unit-tested in the node env).
- Biome: `lint/suspicious/noControlCharactersInRegex` is an error — no literal control chars in
  regexes.
- E2E runs strictly serially. A PTY-ish or timing failure on a loaded machine must be re-run
  ALONE before being believed (CLAUDE.md).
- All commands run inside the task worktree, never the main checkout. Never place a worktree
  inside the repo (`biome check .` breaks on a nested root config) — use `.claude/worktrees`.
- Monaco internals reached from `webview/` need a declaration in `types/monaco-internal.d.ts`;
  never `as any` / `@ts-ignore` a missing monaco type.

## Verified facts this plan is built on

Read before editing; each was checked against the bundle in `node_modules/` on 2026-08-21.

- `TypeScriptWorker` (`monaco-editor/esm/vs/language/typescript/tsWorker.js`) exposes
  `getDefinitionAtPosition`, `getReferencesAtPosition`, `getSemanticDiagnostics`,
  `getSyntacticDiagnostics`, `getQuickInfoAtPosition` … and **not**
  `getTypeDefinitionAtPosition` / `getImplementationAtPosition` — those are ours
  (`webview/ts.worker.ts`). **No worker change is needed in this plan**; only the ambient
  declaration in `types/monaco-internal.d.ts` has to grow.
- `getSemanticDiagnostics` returns `TypeScriptWorker.clearFiles(...)` output: the objects keep
  `code`, `start`, `length`, `messageText`, and carry `file` reduced to `{ fileName }`.
- `MessageController.ID === 'editor.contrib.messageController'`, `showMessage(message, position)`
  (`monaco-editor/esm/vs/editor/contrib/message/browser/messageController.js`). It is pulled into
  the bundle by `gotoSymbol/browser/goToCommands.js`, which is already loaded, and it renders a
  `.monaco-editor-overlaymessage` node that auto-closes on cursor move / model change.
- `SymbolNavigationAction.runEditorCommand` shows Monaco's own message **only when
  `referenceCount === 0`**. Because this plan dispatches a built-in command only when
  `resultCount >= 2` (or for a references/peek command that produced results), Monaco's
  "No definition found" can no longer fire.
- Keybinding precedence: `editor.addAction({ keybindings })` →
  `StandaloneKeybindingService.addDynamicKeybinding` → `weight1: 1000`, registered as a resolver
  **override**; `KeybindingResolver._findCommand` walks matches from the END and returns the first
  whose `when` matches. Monaco's own F12 is a *default* at `KeybindingWeight.EditorContrib` (100).
  **Ours wins and only one command runs per keypress — there is no double-fire.** No change is
  required to `NAV_KEYBINDINGS` in `webview/components/code-viewer.tsx`; Task 4 only *proves* it.

---

### Task 1: `webview/nav-outcome.ts` — the pure classifier and all the copy

**Files:**
- Create: `webview/nav-outcome.ts`
- Test: `test/unit/nav-outcome.test.ts` (new; style-match `test/unit/ts-index-state.test.ts`)

**Interfaces** (later tasks rely on these exact names):

```ts
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

export function navCommandKind(commandId: string): NavCommandKind | null;

export interface NavClassifyInput {
  kind: NavCommandKind;
  /** Locations the provider produced, AFTER dropping targets we hold no content for. */
  resultCount: number;
  /** The sole result is an import alias whose own module is unresolved — the import the
   *  symbol came through. True for the importing file itself AND for a barrel in another
   *  file (that's the hop case, see Task 3). */
  soleResultIsUnresolvedAlias: boolean;
  /** The unresolved module specifier behind the cursor, when one was found. */
  unresolved: { specifier: string; fromFile: string } | null;
  /** `isIndexReady()` — the project index finished streaming. */
  indexReady: boolean;
  /** Active model's language is TS/JS. */
  supported: boolean;
  /** The navigation blew its deadline. */
  timedOut: boolean;
}

export function classifyNavOutcome(input: NavClassifyInput): NavOutcome;

export interface NavMessageContext {
  kind: NavCommandKind;
  /** `model.getWordAtPosition(position)?.word ?? null` — drives row 40's copy. */
  word: string | null;
  index: { loaded: number; total: number; done: boolean };
}

export interface NavMessage {
  text: string;
  /** `inline` = at the cursor (Monaco's MessageController); `toast` = the global stack. */
  channel: 'inline' | 'toast';
  variant: 'info' | 'error';
}

/** The FINAL message for an outcome; `null` when the outcome speaks for itself. */
export function navOutcomeMessage(o: NavOutcome, ctx: NavMessageContext): NavMessage | null;

/** The in-flight notice shown while an on-demand resolve is running (Plan B). */
export function resolvingMessage(specifier: string): NavMessage;

/** TS error codes that mean "this module specifier did not resolve". */
export const UNRESOLVED_MODULE_CODES: ReadonlySet<number>; // 2307, 7016, 2792

/** How many alias→barrel hops one navigation may chase before giving up honestly (Task 3
 *  consumes it; it lives here so it is reachable from the node test env). */
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

/** Unresolved-module specifier spans in one file, from its semantic diagnostics + its text. */
export function unresolvedSpecifierSpans(
  diagnostics: readonly DiagnosticLike[],
  text: string,
): SpecifierSpan[];

/** The span containing `offset`, if any (cursor sitting on the specifier literal). */
export function specifierSpanAt(spans: readonly SpecifierSpan[], offset: number): SpecifierSpan | null;

/** The specifier an import ALIAS came through: the nearest unresolved span that starts at or
 *  after the alias and is still inside the same statement. */
export function specifierForAlias(
  alias: { start: number; length: number },
  spans: readonly SpecifierSpan[],
  text: string,
): SpecifierSpan | null;
```

- [ ] **Step 1: Write the failing tests** — `test/unit/nav-outcome.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  classifyNavOutcome,
  type NavClassifyInput,
  navCommandKind,
  navOutcomeMessage,
  resolvingMessage,
  specifierForAlias,
  specifierSpanAt,
  UNRESOLVED_MODULE_CODES,
  unresolvedSpecifierSpans,
} from '../../webview/nav-outcome';

const base: NavClassifyInput = {
  kind: 'definition',
  resultCount: 0,
  soleResultIsUnresolvedAlias: false,
  unresolved: null,
  indexReady: true,
  supported: true,
  timedOut: false,
};
const at = (o: Partial<NavClassifyInput>) => classifyNavOutcome({ ...base, ...o });

describe('navCommandKind', () => {
  it('maps every command the editor menu can dispatch', () => {
    expect(navCommandKind('editor.action.revealDefinition')).toBe('definition');
    expect(navCommandKind('editor.action.goToTypeDefinition')).toBe('typeDefinition');
    expect(navCommandKind('editor.action.goToImplementation')).toBe('implementation');
    expect(navCommandKind('editor.action.goToReferences')).toBe('references');
    expect(navCommandKind('editor.action.referenceSearch.trigger')).toBe('references');
    expect(navCommandKind('editor.action.peekDefinition')).toBe('peek');
    expect(navCommandKind('editor.action.somethingElse')).toBeNull();
  });
});

describe('classifyNavOutcome', () => {
  it('a non-TS model is unsupported before anything else is considered', () => {
    expect(at({ supported: false, resultCount: 3 })).toEqual({ kind: 'unsupported' });
  });

  it('a blown deadline beats every result-shaped verdict', () => {
    expect(at({ timedOut: true, resultCount: 1 })).toEqual({ kind: 'timed-out' });
  });

  it('exactly one definition result navigates', () => {
    expect(at({ resultCount: 1 })).toEqual({ kind: 'navigated' });
    expect(at({ kind: 'typeDefinition', resultCount: 1 })).toEqual({ kind: 'navigated' });
    expect(at({ kind: 'implementation', resultCount: 1 })).toEqual({ kind: 'navigated' });
  });

  it('two or more results peek — row 12, and NO toast', () => {
    expect(at({ resultCount: 2 })).toEqual({ kind: 'peeked' });
    expect(at({ resultCount: 9 })).toEqual({ kind: 'peeked' });
  });

  it('references and peek commands peek even with a single result — row 13', () => {
    expect(at({ kind: 'references', resultCount: 1 })).toEqual({ kind: 'peeked' });
    expect(at({ kind: 'peek', resultCount: 1 })).toEqual({ kind: 'peeked' });
  });

  it('references with nothing found is none, not peeked', () => {
    expect(at({ kind: 'references', resultCount: 0 })).toEqual({ kind: 'none' });
  });

  it('zero results with an unresolved specifier is resolving — row 37', () => {
    expect(at({ unresolved: { specifier: 'zod', fromFile: 'file:///g:/p/src/a.ts' } })).toEqual({
      kind: 'resolving',
      specifier: 'zod',
      fromFile: 'file:///g:/p/src/a.ts',
    });
  });

  it('a lone import alias for an unresolved module is resolving, not navigated', () => {
    expect(
      at({
        resultCount: 1,
        soleResultIsUnresolvedAlias: true,
        unresolved: { specifier: 'zod', fromFile: 'file:///g:/p/src/a.ts' },
      }),
    ).toEqual({ kind: 'resolving', specifier: 'zod', fromFile: 'file:///g:/p/src/a.ts' });
  });

  it('a lone alias whose module DID resolve is a plain navigation', () => {
    expect(at({ resultCount: 1, soleResultIsUnresolvedAlias: false })).toEqual({
      kind: 'navigated',
    });
  });

  it('zero results with nothing unresolved is none — rows 37/40', () => {
    expect(at({ resultCount: 0 })).toEqual({ kind: 'none' });
    expect(at({ resultCount: 0, indexReady: false })).toEqual({ kind: 'none' });
  });

  it('an unresolved specifier still says resolving while the index streams — row 45', () => {
    expect(
      at({ indexReady: false, unresolved: { specifier: 'zod', fromFile: 'f' } }).kind,
    ).toBe('resolving');
  });
});

describe('navOutcomeMessage', () => {
  const ready = { loaded: 900, total: 900, done: true };
  const ctx = (over: Partial<Parameters<typeof navOutcomeMessage>[1]> = {}) => ({
    kind: 'definition' as const,
    word: 'foo',
    index: ready,
    ...over,
  });

  it('says nothing for a successful navigation or peek — row 12/13 have no toast', () => {
    expect(navOutcomeMessage({ kind: 'navigated' }, ctx())).toBeNull();
    expect(navOutcomeMessage({ kind: 'peeked' }, ctx())).toBeNull();
  });

  it('names the symbol inline when nothing exists — row 37', () => {
    const m = navOutcomeMessage({ kind: 'none' }, ctx());
    expect(m).toEqual({ text: "No definition for 'foo' here", channel: 'inline', variant: 'info' });
  });

  it('is honest about whitespace / a keyword — row 40', () => {
    expect(navOutcomeMessage({ kind: 'none' }, ctx({ word: null }))?.text).toBe(
      'Nothing to navigate to here',
    );
  });

  it('adapts the noun to the command', () => {
    expect(navOutcomeMessage({ kind: 'none' }, ctx({ kind: 'references' }))?.text).toBe(
      "No references for 'foo' here",
    );
    expect(navOutcomeMessage({ kind: 'none' }, ctx({ kind: 'typeDefinition' }))?.text).toBe(
      "No type definition for 'foo' here",
    );
    expect(navOutcomeMessage({ kind: 'none' }, ctx({ kind: 'implementation' }))?.text).toBe(
      "No implementation for 'foo' here",
    );
  });

  it('reports index progress instead of a false negative — row 45', () => {
    const m = navOutcomeMessage({ kind: 'none' }, ctx({ index: { loaded: 120, total: 900, done: false } }));
    expect(m?.text).toBe('Still indexing this project (120 of 900 files). Try again in a moment.');
    expect(m?.channel).toBe('inline');
  });

  it('never claims a package has no definition — it says it is not indexed', () => {
    const m = navOutcomeMessage({ kind: 'resolving', specifier: 'zod', fromFile: 'f' }, ctx());
    expect(m).toEqual({
      text: "Can’t navigate into 'zod' — it isn’t indexed",
      channel: 'inline',
      variant: 'info',
    });
    expect(m?.text).not.toMatch(/no definition/i);
  });

  it('keeps the existing unsupported / timed-out copy on the toast channel', () => {
    expect(navOutcomeMessage({ kind: 'unsupported' }, ctx())).toEqual({
      text: 'Code navigation is only available for JS/TS files.',
      channel: 'toast',
      variant: 'info',
    });
    expect(navOutcomeMessage({ kind: 'timed-out' }, ctx())).toEqual({
      text: 'Couldn’t resolve in time. Try again.',
      channel: 'toast',
      variant: 'error',
    });
  });

  it('the in-flight notice names what is being fetched', () => {
    expect(resolvingMessage('date-fns/format')).toEqual({
      text: "Resolving 'date-fns/format'…",
      channel: 'inline',
      variant: 'info',
    });
  });
});

describe('unresolved specifier extraction', () => {
  const text = `import { z } from 'zod';\nimport { a } from './a';\nimport L from "lodash";\n`;
  const spanOf = (needle: string) => ({ start: text.indexOf(needle), length: needle.length });

  it('reads the specifier out of the diagnostic SPAN, not the message text', () => {
    const spans = unresolvedSpecifierSpans(
      [
        { code: 2307, ...spanOf(`'zod'`), messageText: "Cannot find module 'zod'." },
        { code: 7016, ...spanOf(`"lodash"`), messageText: 'Could not find a declaration file' },
      ],
      text,
    );
    expect(spans.map((s) => s.specifier)).toEqual(['zod', 'lodash']);
  });

  it('drops diagnostics that are not module-resolution failures', () => {
    expect(unresolvedSpecifierSpans([{ code: 2322, start: 0, length: 3 }], text)).toEqual([]);
    expect([...UNRESOLVED_MODULE_CODES].sort()).toEqual([2307, 2792, 7016]);
  });

  it('drops a span that is not a quoted literal (defensive against a shifted model)', () => {
    expect(unresolvedSpecifierSpans([{ code: 2307, start: 0, length: 6 }], text)).toEqual([]);
  });

  it('finds the span under the cursor — cursor parked on the specifier itself', () => {
    const spans = unresolvedSpecifierSpans([{ code: 2307, ...spanOf(`'zod'`) }], text);
    expect(specifierSpanAt(spans, text.indexOf('zod') + 1)?.specifier).toBe('zod');
    expect(specifierSpanAt(spans, 0)).toBeNull();
  });

  it('walks an alias forward to its own import specifier', () => {
    const spans = unresolvedSpecifierSpans(
      [
        { code: 2307, ...spanOf(`'zod'`) },
        { code: 7016, ...spanOf(`"lodash"`) },
      ],
      text,
    );
    const zAlias = { start: text.indexOf('z }') , length: 1 };
    expect(specifierForAlias(zAlias, spans, text)?.specifier).toBe('zod');
    const lAlias = { start: text.indexOf('L from'), length: 1 };
    expect(specifierForAlias(lAlias, spans, text)?.specifier).toBe('lodash');
  });

  it('does not jump across a statement boundary to a LATER unresolved import', () => {
    const aAlias = { start: text.indexOf('a }'), length: 1 };
    const spans = unresolvedSpecifierSpans([{ code: 7016, ...spanOf(`"lodash"`) }], text);
    expect(specifierForAlias(aAlias, spans, text)).toBeNull();
  });

  it('handles a multi-line import', () => {
    const t = `import {\n  first,\n  second,\n} from '@scope/pkg';\n`;
    const spans = unresolvedSpecifierSpans(
      [{ code: 2307, start: t.indexOf(`'@scope/pkg'`), length: `'@scope/pkg'`.length }],
      t,
    );
    expect(specifierForAlias({ start: t.indexOf('first'), length: 5 }, spans, t)?.specifier).toBe(
      '@scope/pkg',
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/nav-outcome.test.ts`.
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `webview/nav-outcome.ts`**

Rules, in order, inside `classifyNavOutcome`:

1. `!supported` → `unsupported`.
2. `timedOut` → `timed-out`.
3. `unresolved && (resultCount === 0 || soleResultIsUnresolvedAlias)` → `resolving`.
4. `kind === 'references' || kind === 'peek'` → `resultCount > 0 ? 'peeked' : 'none'`.
5. `resultCount === 0` → `none`.
6. `resultCount === 1` → `navigated`.
7. otherwise → `peeked`.

`indexReady` is deliberately **not** a classification input beyond documentation: an empty
result while the index streams is still honestly `none` *as a verdict*; what changes is the
message, which `navOutcomeMessage` picks from `ctx.index.done`. Keep the field on
`NavClassifyInput` (the caller has it, and the doc comment records why it is inert) — do not
invent an eighth outcome.

`unresolvedSpecifierSpans`: filter by `UNRESOLVED_MODULE_CODES`, require numeric
`start`/`length`, slice `text`, require the slice to match `/^(['"])(.+)\1$/` with no newline
inside, emit `{ specifier: match[2], start, length }`. Ignore `messageText` entirely — it is
localized and its quoting varies.

`specifierForAlias`: take spans with `start >= alias.start + alias.length`, sorted by `start`,
take the first; return `null` if `text.slice(aliasEnd, span.start)` contains a `;` or a `}`
followed by a newline followed by `import`/`export` — i.e. a statement boundary. Keep the
bounded-lookahead comment short and point at the spec, not at a re-explanation.

Copy table (exact strings — the e2e asserts them):

| outcome | text | channel |
|---|---|---|
| `navigated` / `peeked` | *(null)* | — |
| `none`, index done, word | `No <noun> for '<word>' here` | inline |
| `none`, index done, no word | `Nothing to navigate to here` | inline |
| `none`, index streaming | `Still indexing this project (<loaded> of <total> files). Try again in a moment.` | inline |
| `none`, index streaming, `total === 0` | `This project hasn’t been indexed yet — cross-file navigation is still warming up.` | inline |
| `resolving` | `Can’t navigate into '<specifier>' — it isn’t indexed` | inline |
| `unsupported` | `Code navigation is only available for JS/TS files.` | toast |
| `timed-out` | `Couldn’t resolve in time. Try again.` | toast |

`<noun>` = `definition` / `type definition` / `implementation` / `references` (references uses
`No references for '<word>' here`). Typographic apostrophes (`’`) match the existing toast copy.

- [ ] **Step 4: Run** — `npx vitest run test/unit/nav-outcome.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add webview/nav-outcome.ts test/unit/nav-outcome.test.ts && git commit -m "feat(nav): pure navigation-outcome classifier and message copy"`

### Task 2: Reach the worker's diagnostics + references — declarations and a shared path helper

**Files:**
- Modify: `types/monaco-internal.d.ts` (module block for
  `'monaco-editor/esm/vs/language/typescript/tsWorker.js'`)
- Modify: `webview/project-index.ts` (add `uriToAbsPath`)
- Modify: `webview/monaco-opener.ts` (use `uriToAbsPath`)
- Create: `webview/monaco-message.ts`
- Test: `test/unit/nav-outcome.test.ts` gains no cases here; `test/unit/project-index-uri.test.ts` (new)

**Interfaces:**
- `types/monaco-internal.d.ts` — `TypeScriptWorker` gains:

```ts
  export interface TsDiagnostic {
    code: number;
    start?: number;
    length?: number;
    messageText?: unknown;
    file?: { fileName: string };
  }
  export class TypeScriptWorker {
    // …existing…
    getReferencesAtPosition(
      fileName: string,
      position: number,
    ): Promise<TsDefinitionInfo[] | undefined>;
    getSemanticDiagnostics(fileName: string): Promise<TsDiagnostic[]>;
  }
```

  (`ReferenceEntry` is structurally a superset of `TsDefinitionInfo` — `fileName` + `textSpan`
  — so `toLocations` consumes it unchanged. Say that in one comment; do not restate the spec.)
- `webview/project-index.ts`:
  `export function uriToAbsPath(uri: monaco.Uri): string;` — the inverse of `fileUri`; today's
  `resource.path.replace(/^\/+/, '')` lives inline in `monaco-opener.ts` and is about to gain a
  second caller. One definition, two callers. (Drive-case canonicalisation is spec contract §4,
  a DIFFERENT task — do not fix it here, and do not add a TODO for it.)
- `webview/monaco-message.ts`:
  `export function showNavMessage(editor: monaco.editor.ICodeEditor, message: NavMessage): void;`
  — routes `channel: 'inline'` to Monaco's `MessageController` and everything else (plus the
  fallback when the contribution is missing) to `pushToast`.

- [ ] **Step 1: Write the failing test** — `test/unit/project-index-uri.test.ts`

`webview/project-index.ts` imports monaco, so this test needs the same treatment other
monaco-touching unit tests use. Check first: `grep -rl "from 'monaco-editor'" test/unit` and
`grep -rn "monaco" vitest.config.*`. **If no monaco stub/alias exists in the unit env**, do not
invent one — instead move `uriToAbsPath`'s body into a monaco-free helper and test that:

```ts
import { describe, expect, it } from 'vitest';
import { absPathFromUriPath } from '../../webview/project-index-path';

describe('absPathFromUriPath', () => {
  it('strips the leading slash monaco puts on a drive path', () => {
    expect(absPathFromUriPath('/g:/repo/src/a.ts')).toBe('g:/repo/src/a.ts');
  });
  it('is idempotent for an already-clean path', () => {
    expect(absPathFromUriPath('g:/repo/src/a.ts')).toBe('g:/repo/src/a.ts');
  });
  it('collapses the multi-slash form', () => {
    expect(absPathFromUriPath('///g:/repo/a.ts')).toBe('g:/repo/a.ts');
  });
  it('leaves a POSIX absolute path rooted', () => {
    expect(absPathFromUriPath('/home/u/p/a.ts')).toBe('home/u/p/a.ts');
  });
});
```

  (That last expectation is what the shipped opener does today — `openDefinitionFile` is fed a
  slash-stripped path on every platform. Preserve the behaviour exactly; changing it is contract
  §4's job, not this plan's.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/project-index-uri.test.ts`.

- [ ] **Step 3: Implement** — add `absPathFromUriPath` (in `webview/project-index.ts` if the
  monaco import is fine in the unit env, otherwise in a new monaco-free
  `webview/project-index-path.ts` that `project-index.ts` re-exports through
  `uriToAbsPath(uri) => absPathFromUriPath(uri.path)`), then rewrite `monaco-opener.ts`'s
  `openCodeEditor` to call `uriToAbsPath(resource)`.

  `webview/monaco-message.ts`:

```ts
import type * as monaco from 'monaco-editor';
import type { NavMessage } from './nav-outcome';
import { pushToast } from './toast-store';

/** Monaco's inline message contribution — the widget its own Go to Definition uses. Reached
 *  by id because the class isn't exported from the public entry; see
 *  docs/specs/2026-08-21-goto-definition-flows.md §3. */
const MESSAGE_CONTROLLER_ID = 'editor.contrib.messageController';

interface MessageController extends monaco.editor.IEditorContribution {
  showMessage(message: string, position: monaco.IPosition): void;
}

export function showNavMessage(editor: monaco.editor.ICodeEditor, message: NavMessage): void {
  const position = editor.getPosition();
  if (message.channel === 'inline' && position) {
    const controller = editor.getContribution<MessageController>(MESSAGE_CONTROLLER_ID);
    if (controller && typeof controller.showMessage === 'function') {
      controller.showMessage(message.text, position);
      return;
    }
  }
  pushToast({ message: message.text, variant: message.variant });
}
```

- [ ] **Step 4: Run** — `npx vitest run test/unit/project-index-uri.test.ts` and
  `npm run typecheck` (both tsconfigs — the ambient declaration must satisfy the webview program).
  Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(nav): declare the worker's diagnostics/references methods; share the uri→path helper"`

### Task 3: Rewrite `runNavCommand` — compute, classify, act

**Files:**
- Modify: `webview/ts-nav.ts` (`ConduitWorker`, `provide`, `runNavCommand`; keep
  `registerTsNavigationProviders`, `targetModel`, `toLocations`, `TS_LANGS`, `NAV_TIMEOUT_MS`)
- Modify: `webview/monaco-opener.ts` (DELETE `openCount` / `openedCount` — dead once the
  `moved` heuristic goes, and `fallow:check` gates on that)
- Test: `test/unit/nav-outcome.test.ts` (extend — the pure hop/plan logic only)

**Interfaces** (produced):

```ts
export interface NavDeps {
  /** Returns whether the caller pushed new content and the navigation is worth retrying.
   *  Unregistered in this plan; docs/plans/2026-08-21-resolve-on-demand.plan.md wires it. */
  onUnresolved?: (fromFile: string, specifier: string) => Promise<boolean>;
}
export function setUnresolvedResolver(fn: NavDeps['onUnresolved'] | null): void;
export function runNavCommand(
  editor: monaco.editor.ICodeEditor,
  commandId: string,
  deps?: NavDeps,
): Promise<NavOutcome>;
/** Re-exported from `webview/nav-outcome.ts` (defined there so the node test env can read it). */
export { NAV_HOP_CAP } from './nav-outcome';
```

`runNavCommand` now RETURNS the outcome (the e2e and Plan B both want it; the two existing
call sites in `code-viewer.tsx` keep using `void runNavCommand(...)` unchanged).

- [ ] **Step 1: Write the failing test** — append to `test/unit/nav-outcome.test.ts`

`ts-nav.ts` is monaco-bound, so the unit net here covers only what stayed pure. Add the hop
budget as a pure exported constant check plus the classification sequence a hop chain walks:

```ts
import { NAV_HOP_CAP } from '../../webview/nav-outcome';

describe('hop budget', () => {
  it('is the documented cap', () => {
    expect(NAV_HOP_CAP).toBe(4);
  });
});
```

  `NAV_HOP_CAP` lives in `webview/nav-outcome.ts` (pure) and is re-exported from `ts-nav.ts`, so
  no new module is needed. The runtime behaviour of the loop is proven by the e2e in Task 5 and
  by Plan B's matrix rows, not by a mock-monaco unit test; do not build a monaco double for it.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/nav-outcome.test.ts`.

- [ ] **Step 3: Implement `webview/ts-nav.ts`**

Extend `ConduitWorker` (it is already a runtime cast across the worker proxy):

```ts
interface ConduitWorker {
  getDefinitionAtPosition(f: string, p: number): Promise<TsDefinitionInfo[] | undefined>;
  getTypeDefinitionAtPosition(f: string, p: number): Promise<TsDefinitionInfo[] | undefined>;
  getImplementationAtPosition(f: string, p: number): Promise<TsDefinitionInfo[] | undefined>;
  getReferencesAtPosition(f: string, p: number): Promise<TsDefinitionInfo[] | undefined>;
  getSemanticDiagnostics(f: string): Promise<TsDiagnostic[]>;
}
```

Add a lookup table beside it:

```ts
const LOOKUPS: Record<NavCommandKind, Lookup> = {
  definition: (w, f, o) => w.getDefinitionAtPosition(f, o),
  // A peek shows DEFINITIONS in a widget — same provider, different presentation.
  peek: (w, f, o) => w.getDefinitionAtPosition(f, o),
  typeDefinition: (w, f, o) => w.getTypeDefinitionAtPosition(f, o),
  implementation: (w, f, o) => w.getImplementationAtPosition(f, o),
  references: (w, f, o) => w.getReferencesAtPosition(f, o),
};
```

`probe(editor, model, position, kind)` — one measurement pass:

```ts
interface NavProbe {
  entries: TsDefinitionInfo[];
  locations: monaco.languages.Location[];
  timedOut: boolean;
}
```

- Capture `model.getVersionId()` before the worker call and compare after. **Row 38:** if the
  version changed underneath, re-run the probe ONCE (a `for (let attempt = 0; attempt < 2; …)`
  loop, not recursion) — our call is not bound to Monaco's
  `EditorStateCancellationTokenSource`, so the only failure mode is a stale answer.
- Wrap the worker call in the existing `withTimeout(..., NAV_TIMEOUT_MS, TIMED_OUT)`; a
  timeout sets `timedOut` and stops the loop.
- Map with the existing `toLocations` (unchanged).

`unresolvedFor(worker, model, position, entries)` — only called when
`locations.length === 0` or `entries.length === 1 && entries[0].kind === 'alias'`:

- Decide the file to diagnose: the alias's `entry.fileName` when there is a sole alias
  (that covers a barrel in ANOTHER file — the hop case, spec rows 7/30), otherwise
  `model.uri.toString()`.
- Get that file's text: `monaco.editor.getModel(monaco.Uri.parse(fileName))?.getValue()` or,
  when no model exists, `monacoTs.typescriptDefaults.getExtraLibs()[fileName]?.content` —
  the same two sources `targetModel` already consults. Extract that pair into a small local
  `textOf(fileName)` helper and have `targetModel` keep using its own path (do not refactor
  `targetModel`; it also creates models, which `textOf` must not).
- `const spans = unresolvedSpecifierSpans(await worker.getSemanticDiagnostics(fileName), text)`.
  Bail early with `null` when `spans.length === 0` — that is the common case and it must not
  cost anything more.
- Sole-alias case → `specifierForAlias(entries[0].textSpan, spans, text)`;
  zero-result case → `specifierSpanAt(spans, model.getOffsetAt(position))`, falling back to
  `specifierForAlias` when the cursor is on the local name rather than the literal.
- Return `{ specifier, fromFile: fileName }` or `null`.

**Cost guard (say this in one comment):** `getSemanticDiagnostics` type-checks the file against
the whole program. It runs only on a MISS (zero locations, or a lone alias), never on the happy
path, and never for a successful multi-result navigation.

`act(editor, outcome, probe)`:

- `navigated` → `openLocation(editor, probe.locations[0])`:

```ts
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
  const abs = uriToAbsPath(loc.uri);
  setReveal(abs, { line: target.lineNumber, column: target.column });
  openDefinitionFile(abs);
}
```

- `peeked` → hand OUR already-computed locations to Monaco's location commands instead of
  re-dispatching the provider-gated action: `editor.action.peekLocations` for the peek
  commands (`peekDefinition`, `referenceSearch.trigger`) and `editor.action.goToLocations`
  for a multi-result go-to (`revealDefinition`/`goToTypeDefinition`/`goToImplementation`/
  `goToReferences` with ≥2 hits). Both are plain `CommandsRegistry` commands in the bundle
  (`goToCommands.js`, registered near the bottom) taking
  `(resource: Uri, position: IPosition, locations: Location[], multiple?: 'peek'|'gotoAndPeek'|'goto', noResultsMessage?, openInPeek?)`
  and running the same `GenericGoToLocationAction` — identical peek widget / picker /
  references pane, **no `hasDefinitionProvider` precondition and no second worker
  round-trip** (closes row 39 on the multi path too). VERIFY the exact handler signature
  in `node_modules/monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands.js`
  before coding; invoke via `StandaloneServices.get(ICommandService).executeCommand(id, uri,
  position, locations, multiple)` (add an argument-passing form to `executeEditorCommand` in
  `webview/monaco-commands.ts`, keeping the existing no-arg form). Pass `multiple: 'peek'`
  for peek commands and `'gotoAndPeek'` for multi-hit go-to (matches
  `gotoLocation.multipleDefinitions` default). Add a `deps.locationCommand` seam so the unit
  test can assert which id + locations were dispatched.
- everything else → no editor action.

`runNavCommand` body:

```ts
export async function runNavCommand(editor, commandId, deps: NavDeps = {}): Promise<NavOutcome> {
  editor.focus();               // menu clicks moved focus away; the commands need it back
  const model = editor.getModel();
  const position = editor.getPosition();
  const kind = navCommandKind(commandId);
  if (!model || !position || !kind) return { kind: 'none' };

  const supported = TS_LANGS.has(model.getLanguageId());
  gotoInflight.begin();
  try {
    let outcome: NavOutcome = { kind: 'none' };
    let probe: NavProbe | null = null;
    for (let hop = 0; hop <= NAV_HOP_CAP; hop++) {
      if (!supported) { outcome = { kind: 'unsupported' }; break; }
      probe = await probeNav(model, position, kind);
      const entries = probe.entries;
      const soleAlias = entries.length === 1 && entries[0].kind === 'alias';
      const unresolved =
        probe.locations.length === 0 || soleAlias
          ? await unresolvedFor(model, position, entries)
          : null;
      outcome = classifyNavOutcome({
        kind,
        resultCount: probe.locations.length,
        soleResultIsUnresolvedAlias: soleAlias && unresolved !== null,
        unresolved,
        indexReady: isIndexReady(),
        supported,
        timedOut: probe.timedOut,
      });
      if (outcome.kind !== 'resolving' || hop === NAV_HOP_CAP) break;
      const resolve = deps.onUnresolved ?? unresolvedResolver;
      if (!resolve) break;                       // Plan A: nobody is listening — report honestly
      showNavMessage(editor, resolvingMessage(outcome.specifier));
      if (!(await resolve(outcome.fromFile, outcome.specifier))) break;
    }
    if (probe && outcome.kind === 'navigated') openLocation(editor, probe.locations[0]);
    else if (probe && outcome.kind === 'peeked')
      await dispatchLocations(editor, kind, probe.locations, deps);   // peekLocations / goToLocations
    const message = navOutcomeMessage(outcome, {
      kind,
      word: model.getWordAtPosition(position)?.word ?? null,
      index: indexStatus(),
    });
    if (message) showNavMessage(editor, message);
    return outcome;
  } finally {
    gotoInflight.end();
  }
}
```

  The hop loop is written here (it is the same code path either way); **Plan B owns proving it**
  with the barrel fixtures — see `docs/plans/2026-08-21-resolve-on-demand.plan.md` §5.

Delete from `webview/ts-nav.ts`: the `moved` computation, `beforeUri`/`beforePos`/`beforeOpens`,
the `isIndexReady()` early return, the old still-indexing `pushToast`, and the `openedCount`
import. Delete `openCount`/`openedCount` from `webview/monaco-opener.ts` and update its header
comment (the counter's stated purpose — "how callers tell a navigation happened" — is exactly
what this task removes). Rewrite `runNavCommand`'s doc comment so it describes computing and
classifying, and link the spec rather than re-explaining it.

- [ ] **Step 4: Run** — `npx vitest run test/unit/nav-outcome.test.ts test/unit/editor-menu.test.ts`,
  then `npm run typecheck`, then `npm run fallow:check` (this is where a missed dead export
  surfaces). Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(nav): compute results in the wrapper and classify the outcome; delete the moved heuristic"`

### Task 4: Entry points — menu, F12, Ctrl+click all land on the same path

**Files:**
- Modify: `webview/components/code-viewer.tsx` (`navigate`, the `onMouseDown` Ctrl/Cmd+click
  handler — both already funnel through `runNavCommand`; the change is removing the
  now-duplicated non-TS toast)
- Test: `test/unit/editor-menu.test.ts` (extend — the menu's action ids must all be classifiable)

**Interfaces:** consumes `runNavCommand`, `navCommandKind` from Tasks 1 and 3.

- [ ] **Step 1: Write the failing test** — append to `test/unit/editor-menu.test.ts`

```ts
import { navCommandKind } from '../../webview/nav-outcome';
import { NAVIGATION } from '../../webview/editor-menu';

it('every navigation menu row maps to a classifiable command kind', () => {
  const unmapped = NAVIGATION.filter((n) => navCommandKind(n.actionId) === null);
  expect(unmapped.map((n) => n.actionId)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails** — it will pass only once Task 1's table covers all six
  ids (`revealDefinition`, `goToTypeDefinition`, `goToImplementation`, `goToReferences`,
  `peekDefinition`, `referenceSearch.trigger`). If it already passes after Task 1, say so and
  move on — a green regression net is a legitimate outcome for this step.

- [ ] **Step 3: Implement** — in `code-viewer.tsx`'s `navigate`, delete the local non-TS
  `pushToast` branch and just call `void runNavCommand(editor, actionId)`; the `unsupported`
  outcome now owns that message with the same copy. Leave the Ctrl/Cmd+click handler's own
  early `return` for non-TS models in place — that path must stay SILENT (clicking off a symbol
  must not scold), and its existing comment already says why. Do not touch `NAV_KEYBINDINGS`.

- [ ] **Step 4: Prove there is no F12 double-fire (row 39's neighbour)** — no code change
  expected; capture the evidence:
  `grep -n "weight1" node_modules/monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js`
  (dynamic keybindings register at `weight1: 1000` as resolver **overrides**) and
  `grep -n "_findCommand" -A 8 node_modules/monaco-editor/esm/vs/platform/keybinding/common/keybindingResolver.js`
  (matches are walked from the END; the FIRST when-matching entry wins and only that command
  runs). Ours is registered after the defaults, so it wins and Monaco's F12 never also fires.
  Record this in the commit body. If a future monaco inverts it, the Task 5 e2e's
  single-outcome assertion is the tripwire.

- [ ] **Step 5: Run** — `npx vitest run test/unit/editor-menu.test.ts`; `npm run typecheck`.
- [ ] **Step 6: Commit** — `git commit -m "refactor(nav): one message owner for every navigation entry point"`

### Task 5: E2E — rows 12, 13, 37, 38, 39, 40, 45 + full verify

**Files:**
- Modify: `test/e2e/goto-matrix.e2e.mjs` (rows owned by this plan; the matrix scenario and
  `test/e2e/fixtures/goto/build-fixture.mjs` are built by the fixture task — **do not create
  them here**; if they are absent, STOP and report rather than inventing a parallel harness)
- Modify: `test/e2e/goto-index.e2e.mjs` (its "conduit.goToDefinition" assertions must still
  pass; the action ids and the cross-file landing are unchanged, so expect no edit — verify)
- Modify: `docs/specs/INDEX.md` (leave the row; append `— §3 shipped` only if the spec's
  frontmatter status is updated by the run's final task, not here), `CHANGELOG.md`
  (`## [Unreleased]` → Fixed: navigation now says what actually happened instead of Monaco's
  wrong "No definition found")

**Interfaces:** consumes everything above through the real app.

- [ ] **Step 1: Capture the red** — before touching the scenario, run the matrix against the
  PRE-change build (`git stash` this branch's `webview/` changes, `npm run build`,
  `node test/e2e/run-smoke.mjs goto-matrix`) and save the output. Rows 12/13 must fail on the
  spurious "still indexing" toast; 37/40 on Monaco's own message; 45 on nothing being said.
  Unstash and rebuild before Step 2.

- [ ] **Step 2: Make this plan's rows green.** Assertions, per row (drive each through the app's
  own action — `editor.getAction('conduit.goToDefinition')?.run()` etc., as `goto-index.e2e.mjs`
  already does — never by calling the worker directly):

  - **Row 12** (overload / enum member, ≥2 results): the peek widget appears
    (`.monaco-editor .zone-widget`, or whatever selector the matrix scenario already
    standardises on) AND `page.locator('.toast__msg')` has count 0. The spurious
    "Still indexing" toast is the regression this row exists for.
  - **Row 13** (cursor already on the declaration → references peek): peek appears, no toast.
  - **Row 37** (zero results, index complete): `.monaco-editor-overlaymessage` is visible and
    its text matches `/^No definition for '\w+' here$/` — and explicitly
    `expect(text).not.toMatch(/No definition found/)`. Monaco's wording appearing anywhere is a
    hard failure.
  - **Row 38** (concurrent model re-seed): place the cursor, kick the navigation, and mutate the
    model in the same tick (`model.applyEdits([...])` appending a line far from the cursor), then
    assert the navigation still lands (the re-probe) or reports — never silence. Assert
    `runNavCommand`'s returned outcome via `window.__navOutcome` only if the matrix scenario
    already exposes such a hook; otherwise assert the observable end state (landed tab or a
    visible message).
  - **Row 39** (F12 on the very first file, before Monaco's TS providers have settled): open a
    file and fire the action immediately, with no wait. Assert an outcome is produced within the
    scenario budget — a landed tab, a peek, or a visible message — and that the editor is not
    left silent. This is the row the old code failed by returning early on a false provider
    precondition; our worker call has no precondition, which is the point.
  - **Row 40** (right-click on whitespace / a keyword / inside a string): the inline message
    reads exactly `Nothing to navigate to here`.
  - **Row 45** (during indexing): open a session and fire a navigation that misses BEFORE the
    index completes; assert the inline message matches
    `/^Still indexing this project \(\d+ of \d+ files\)\./`. If the fixture indexes too fast to
    hit this window reliably, drive it from the fixture's own large tree rather than adding a
    test-only delay to production code — and if it still cannot be made deterministic, say so
    in the run report instead of weakening the assertion.

  Every OTHER matrix row must be left exactly as it was (still red where Plan B and the
  index-hygiene task own it). Capture the before/after row table.

- [ ] **Step 3: Serial regression** — one at a time, never in parallel:
  `node test/e2e/run-smoke.mjs goto-index`, then `editor-first-paint`, `editor-preview-tabs`,
  `reveal`, `tab-scroll-state`. Any failure: re-run ALONE on a quiet machine before believing it.
- [ ] **Step 4: Full gate** — `npm run verify` in the worktree, complete unfiltered output
  captured to evidence (never `| tail` it — that has hidden "Found N errors" before). Read the
  tail yourself.
- [ ] **Step 5: Commit** — `git commit -m "test(nav): e2e proof for classified navigation outcomes (rows 12,13,37-40,45)"`

## Self-review notes (already applied)

- Spec §3 maps to: classifier + copy → Task 1; inline message channel → Task 2; compute-then-act,
  `moved` deleted → Task 3; single entry-point owner → Task 4; rows → Task 5. Rows 12, 13, 37, 38,
  39, 40, 45 each have a named assertion. Rows 41 (`unsupported`) and 42/43/44 (path identity)
  are deliberately NOT here — 41 is unchanged behaviour, 42–44 are contract §4's task.
- Names cross-checked for consistency across tasks: `NavOutcome`, `NavCommandKind`,
  `classifyNavOutcome`, `navOutcomeMessage`, `resolvingMessage`, `unresolvedSpecifierSpans`,
  `specifierSpanAt`, `specifierForAlias`, `UNRESOLVED_MODULE_CODES`, `NAV_HOP_CAP`, `NavDeps`,
  `setUnresolvedResolver`, `showNavMessage`, `uriToAbsPath`.
- Dead-code trap handled: `openedCount` dies with the heuristic (Task 3), or `fallow:check` fails.
- `webview/ts.worker.ts` needs NO change — `getDefinitionAtPosition`, `getReferencesAtPosition`
  and `getSemanticDiagnostics` are all on monaco's own `TypeScriptWorker`.
- **Conductor decision (taken):** the `peeked` path does NOT re-dispatch the provider-gated
  built-in action; it feeds our computed locations to `editor.action.peekLocations` /
  `editor.action.goToLocations` (see Task 3's `peeked` bullet) — same UX, no precondition, no
  second round-trip. Row 39 is therefore closed on every path.
- Line numbers are not cited anywhere on purpose — re-locate by symbol before editing.
