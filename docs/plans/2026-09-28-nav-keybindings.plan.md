# Configurable code-navigation shortcuts — implementation plan

**Spec:** `docs/specs/2026-09-28-nav-keybindings.md`  **Tier:** FULL

Triage: FULL — a new global seam (a per-window Monaco keybinding rule owner plus dispatch
commands), two keybinding systems, and three editor surfaces; the spec is FULL.

## Goal

Go to Definition / Implementations / References become rows in Settings → Shortcuts whose chord
applies live on every Monaco surface (code viewer, diff, plan blocks, peek), with the default chords
removed once a row is overridden.

## Architecture

Three layers, one owner each:

1. **Pure** (node-testable, no monaco import): `webview/nav-keybindings.ts` turns
   `settings.shortcuts` into a Monaco rule list, conflict list and menu hints;
   `webview/editor-combo.ts` captures and validates editor-row chords;
   `webview/monaco-keybinding.ts` translates combos ↔ Monaco key numbers / chords.
2. **Monaco adapter** `webview/monaco-nav-keybindings.ts` — the ONLY module that calls
   `monaco.editor.addKeybindingRules` / `addCommand` for nav. Owns the code-viewer editor identity
   set, the three dispatch commands, the rule-set rebuild hook, and the read of Monaco's default
   keybinding registry.
3. **Consumers**: `app.tsx` mounts the hook once per window; `code-viewer.tsx` registers its editor
   and binds its `conduit.*` nav actions only at default chords; the extracted
   `shortcuts-tab.tsx` records, validates and shows conflicts; `editor-menu.ts` prints effective
   hints.

No sketches: every seam mirrors an existing precedent (`monacoKeybindingFor`'s injected tables,
`nav-editors.ts`'s register/unregister, `monaco-commands.ts`'s deep import + `types/monaco-internal.d.ts`).

## Data flow

```
Settings → Shortcuts (shortcuts-tab.tsx)
  keydown ─ editorComboFromEvent(e,isMac) ─ validateEditorCombo ─┬─ reason → refusal line + live region
                                                                  └─ ok → update({shortcuts}) (default ⇒ delete key)
        │ useSettings → host 'updateSettings' → persist + postState → every window hydrates
        ▼
settings.shortcuts ──┬─▶ app.tsx useMonacoNavKeybindings(shortcuts)
                     │     mount:  monaco.editor.addCommand × 3  (conduit.dispatch.<navId>)
                     │     change: dispose old; addKeybindingRules(buildNavRules(shortcuts, toBinding))
                     │               per overridden row: '-<builtin>' × each default chord
                     │                                   + chord → conduit.dispatch.<navId>, when editorTextFocus
                     ├─▶ code-viewer [editor, settings.shortcuts] effect
                     │     conduit.<NAVIGATION.id> actions: default chord if not overridden, else none
                     ├─▶ code-viewer context menu: navMenuHints(shortcuts, formatCombo)
                     └─▶ shortcuts-tab: findConflicts(id, shortcuts, readMonacoDefaultBindings())

keypress in any editor ─▶ Monaco resolver ─▶ conduit.dispatch.<navId>.run
   focused = monaco.editor.getEditors().find(e => e.hasTextFocus())
   focused ∈ codeViewerEditors (registerCodeViewerEditor) → runNavCommand(focused, builtin)
   otherwise (diff / plan / peek embedded)                → focused.trigger('keyboard', builtin, undefined)
```

All state is renderer-side and per window. Nothing new crosses IPC; persistence is the existing
`AppSettings.shortcuts` string map.

## Settled decisions — do not re-litigate

- N1: new group **"Code navigation"** placed immediately after "Editor".
- N2: editor rows refuse untranslatable, digit-family and typing chords with an inline reason.
- N3: diff/plan/peek run Monaco built-ins; only the chord is unified.
- N4: only Definition, Implementations, References.
- N5: no unbind.
- N6: the global rule set is **empty at default**; dispatch only for overridden rows.
- N7 (re-locked after review): `e.keyCode` capture for editor rows only — the code Monaco resolves
  on (`keyboardEvent.js` `extractKeyCode`); app rows keep `e.key`. `KeyEvt` gains `keyCode?`.
- H1: Slice 1 is the spike. If AC-5 / AC-5b(revised) / AC-5c fail in the built app, the executor
  **stops and reports** — no no-op override rules, no context-key hacks.
- Conflicts warn, never block. Nav chords have no `app.tsx` `actionMap` entry (A6).
- No change to `AppSettings`, `src/settings.ts`, `strMap` or the persisted file.

## Spec staleness

- **AC-5b as written cannot pass.** `editor.action.goToReferences` has precondition
  `hasReferenceProvider && PeekContext.notInPeekEditor && !isInEmbeddedEditor`
  (`node_modules/monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands.js:545`), so
  References never runs in a peek's embedded editor on any chord, today included. This plan
  re-targets AC-5b to **Definition** (precondition only `hasDefinitionProvider`, same file l.234):
  with Definition = Alt+D and a references peek open, F12 in the embedded editor is inert and
  Alt+D navigates. The routing claim under test (focused-editor identity, not context key) is the
  same.
- **Id mismatch:** `NAVIGATION` (`webview/editor-menu.ts:73`) uses `goToImplementations` (plural);
  the spec's shortcut id is `goToImplementation`. Rows are linked by `monacoCommand` ===
  `NAVIGATION[].actionId`, never by id. The code-viewer action ids (`conduit.goToImplementations`)
  do not change.
- **Monaco default chords confirmed from source** (`goToCommands.js`): revealDefinition F12 +
  `CtrlCmd+F12` when `isWeb` (l.237/241); goToImplementation `CtrlCmd+F12` (l.479); goToReferences
  `Shift+F12` (l.549). Removal support confirmed in source only: `StandaloneKeybindingService`
  treats `addKeybindingRules` entries as overrides (`standaloneServices.js` `_getResolver`), and
  `KeybindingResolver.handleRemovals` removes `isDefault` items matching a `-command` override,
  comparing `when` only if the removal has one. Still measured by Slice 1.
- Existing change-row hints print the raw combo (`'Mod+F7'`, `editor-menu.ts` `changeCombos`);
  not fixed here (out of scope).

## Global constraints

- Gate: `npm run verify` (never narrowed/disabled). Typecheck runs both tsconfigs.
- Inner loop per task: `npx vitest related <touched files> --run` and `npm run typecheck`.
- `npm run verify` once before handoff; capture exit code into a log, never piped:
  `npm run verify *> "$env:TEMP\claude-scratch\verify.log"; $LASTEXITCODE` (PowerShell).
- e2e: `npm run build`, then ONE scenario at a time, hidden (default harness):
  `node test/e2e/run-smoke.mjs <name>`. Never the full suite. A PTY-flavoured failure is re-run
  alone on a quiet machine before being believed; never kill processes by name.
- Unit tests live in `test/unit/<module>.test.ts`, vitest, **platform-independent**: pass `mac`
  explicitly, never read `process.platform`/`navigator`.
- File names kebab-case; hooks `useX`; constants `SCREAMING_SNAKE`; types PascalCase.
- Comments: WHY only, no restating code; point at the spec (`// see nav-keybindings spec §3`)
  rather than re-explaining it.
- No `as any` / `@ts-ignore`; deep monaco imports get declarations in `types/monaco-internal.d.ts`.
- New CSS uses existing tokens only; no bare generic class names (Monaco cascade gotcha) — use the
  `shortcuts__` prefix.
- Scratch artifacts (screenshots, logs) go to `%TEMP%\claude-scratch\`, deleted before handoff.
- Do not touch `src/settings.ts` (sibling item auto-save edits it). In `settings-modal.tsx` only the
  `Shortcuts`/`RecorderEscape` block, its import line, and the `<Shortcuts` call site change.

## Out of scope

Ctrl/Cmd+click; routing diff/plan/peek through `runNavCommand`; peek/find-all/type-definition rows;
chord sequences; unbind; app-row recorder behaviour (still `e.key`, still permissive); command
palette rows; reformatting the existing peek/find-all/change-row menu hints.

## Contracts

### `webview/shortcuts.ts` (modify)

```ts
export interface ShortcutAction {
  id: string;
  description: string;
  group: string;
  defaultCombo: string;
  /** Absent ⇒ 'app'. 'editor' rows are dispatched by Monaco only, never by app.tsx. */
  scope?: 'app' | 'editor';
  /** Monaco built-in id; also the key into NAVIGATION / runNavCommand. */
  monacoCommand?: string;
}
```
Three entries inserted directly after `toggleHtmlView` (so the group renders after "Editor"):

| id | description | group | defaultCombo | scope | monacoCommand |
|---|---|---|---|---|---|
| `goToDefinition` | `Go to Definition` | `Code navigation` | `F12` | `editor` | `editor.action.revealDefinition` |
| `goToImplementation` | `Go to Implementations` | `Code navigation` | `Mod+F12` | `editor` | `editor.action.goToImplementation` |
| `goToReferences` | `Go to References` | `Code navigation` | `Shift+F12` | `editor` | `editor.action.goToReferences` |

### `webview/nav-keybindings.ts` (create, pure)

```ts
/** Module-private. Every default chord per nav built-in (goToCommands.js l.237/241/479/549). */
const NAV_BUILTIN_DEFAULT_CHORDS: Readonly<Record<string, readonly string[]>> = {
  'editor.action.revealDefinition': ['F12', 'Mod+F12'],
  'editor.action.goToImplementation': ['Mod+F12'],
  'editor.action.goToReferences': ['Shift+F12'],
};
/** SHORTCUT_ACTIONS entries with scope 'editor' and a monacoCommand, in array order. */
export function navShortcutActions(): ShortcutAction[];
/** Modifiers reordered Mod, Ctrl, Alt, Shift, then the key: 'Shift+Alt+F5' → 'Alt+Shift+F5'. */
export function canonicalCombo(combo: string): string;
/** The stored override iff present and canonically different from the default, else undefined. */
export function navOverride(action: ShortcutAction, overrides: Readonly<Record<string, string>>): string | undefined;
/** true iff monacoCommand belongs to a nav row with a navOverride. false for peek/find-all. */
export function isNavOverridden(monacoCommand: string, overrides: Readonly<Record<string, string>>): boolean;
export function navDispatchCommandId(actionId: string): string; // `conduit.dispatch.${actionId}`

export interface NavKeybindingRule { command: string; keybinding: number; when?: string }
export function buildNavRules(
  overrides: Readonly<Record<string, string>>,
  toBinding: (combo: string) => number | null,
): NavKeybindingRule[];
```
`buildNavRules` invariants: `[]` when no row is overridden; per overridden row, in
`navShortcutActions()` order: one `{ command: '-' + monacoCommand, keybinding: toBinding(chord) }`
per `NAV_BUILTIN_DEFAULT_CHORDS` entry (no `when`), then `{ command: navDispatchCommandId(id),
keybinding, when: 'editorTextFocus' }` only if `toBinding(override)` is non-null (an unbindable
stored value keeps the removals). A NON-overridden row also gets a removal for each of its default
chords that is another, overridden row's own `defaultCombo` (revision: Implementations-only ⇒
`-editor.action.revealDefinition` on Mod+F12). Pure and deterministic (same input ⇒ deep-equal
output).

Added in the review revision (all pure, in `nav-keybindings.ts`):
```ts
/** bindings minus every chord an overridden nav row owns; applied to EVERY code-viewer
 *  keybinding (nav, Save, Word Wrap, change nav) so the nav chord always wins. */
export function dropNavChords(bindings: readonly number[], overrides, toBinding): number[];
/** 'toggleFindRegex' → 'Toggle Find Regex'; conflict-label fallback after the action label
 *  and MenuRegistry title. */
export function humanizeCommandId(id: string): string;
/** Monaco's compact accelerator style for the context-menu nav hints ('Alt+D', '⌥D'). */
export function formatMonacoHint(combo: string, mac: boolean): string;
```
Code viewer: `agentdeck.saveFile` and `agentdeck.toggleWordWrap` move from the mount effect into the
`[editor, settings.shortcuts, update]` effect (Save via a `saveRef`); the redundant
`editor.addCommand(Mod+S)` is dropped (its chord is the action's, and an `addCommand` binding can't
be disposed to re-register).

Added in Slice 3:
```ts
export interface MonacoDefaultBinding { command: string; label: string; combo: string }
export type Conflict =
  | { kind: 'app'; actionId: string; label: string; editorScoped: boolean }
  | { kind: 'monaco'; command: string; label: string }
  | { kind: 'codeViewer'; label: string };
/** Code-viewer addAction/addCommand chords that are not SHORTCUT_ACTIONS rows (code-viewer.tsx
 *  Save Mod+S, Toggle Word Wrap Alt+Z). */
const CODE_VIEWER_CHORDS: readonly { combo: string; label: string }[] = [  // module-private (fallow)
  { combo: 'Mod+S', label: 'Save File' },
  { combo: 'Alt+Z', label: 'Toggle Word Wrap' },
];
export function findConflicts(
  actionId: string,
  overrides: Readonly<Record<string, string>>,
  monacoDefaults: readonly MonacoDefaultBinding[],
): Conflict[];
```
`findConflicts`: compare by `canonicalCombo` of effective combos. App conflicts for every row
(`editorScoped` = the other row's `scope === 'editor'`). Monaco and codeViewer conflicts only when
`actionId`'s row is `scope: 'editor'`; Monaco defaults whose `command` is any nav row's
`monacoCommand` are excluded (covers the rows' own defaults and any chord the rule set removed).

Added in Slice 4:
```ts
/** monacoCommand → format(effective combo) for the three nav rows. */
export function navMenuHints(
  overrides: Readonly<Record<string, string>>,
  format: (combo: string) => string,
): Record<string, string>;
```

### `webview/monaco-keybinding.ts` (modify, pure)

- `keyCodeName` becomes exported `monacoKeyCodeName(token: string): string | null`, extended:
  arrows `ArrowLeft|Right|Up|Down` → `LeftArrow|RightArrow|UpArrow|DownArrow`; `Home End PageUp
  PageDown Insert Delete Enter Tab Escape Backspace Space` → same name; punctuation
  `` ` `` `-` `=` `[` `]` `\` `;` `'` `,` `.` `/` → `Backquote Minus Equal BracketLeft BracketRight
  Backslash Semicolon Quote Comma Period Slash`. Anything else (shifted punctuation `>`, `1…9`)
  → `null`. `monacoKeybindingFor` unchanged in signature.
- Slice 3 adds
  `comboFromChord(chord: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; keyCode: number }, keyCodeNames: Readonly<Record<number, string>>, mac: boolean): string | null`
  — inverse translation, canonical order; `null` when the key name has no combo token or when
  `metaKey` is set off-mac (no grammar token for the Windows key).

### `webview/editor-combo.ts` (create, pure)

```ts
/** Editor-row capture: key token from e.keyCode (65–90→A–Z, 48–57→0–9, 32→Space, OEM 186–192 and
 *  219–222 → ; = , - . / ` [ \ ] '),
 *  otherwise e.key for named keys (F12, ArrowLeft, Home…). Modifier-only ⇒ null. A modified 1–9
 *  yields the '1…9' family token (mirrors comboFromEvent). Mod = metaKey on mac, ctrlKey elsewhere;
 *  literal Ctrl only on mac. */
export function editorComboFromEvent(e: KeyEvt, mac: boolean): string | null;
/** null = ok. Rule order: '1…9' or monacoKeyCodeName(key)===null → "This key can't be bound in
 *  the editor"; no modifier or Shift-only with a single-character key or
 *  Enter/Tab/Backspace/Space/Delete → 'This key types text in the editor' (module-private
 *  constants; tests assert the literal text). Bare F-keys and bare arrows/Home/End/PageUp/PageDown are ok. */
export function validateEditorCombo(combo: string): string | null;
```
`KeyEvt` is imported from `webview/shortcuts.ts` (already has `code?`).

### `webview/monaco-nav-keybindings.ts` (create, monaco-coupled)

```ts
/** monaco.KeyMod/KeyCode tables for monacoKeybindingFor; moved here from code-viewer.tsx. */
export const MONACO_KEY_TABLES: MonacoKeyTables;
/** Identity set (not path-keyed: a split pane may show one path twice). */
export function registerCodeViewerEditor(editor: monaco.editor.ICodeEditor): () => void;
/** Once per window, from app.tsx. Mount: addCommand per nav row (disposed on unmount).
 *  On every `shortcuts` change: dispose previous rules, addKeybindingRules(buildNavRules(...)). */
export function useMonacoNavKeybindings(shortcuts: Readonly<Record<string, string>>): void;
```
Dispatch body (private): focused editor = `monaco.editor.getEditors().find((e) => e.hasTextFocus())`;
none → return; in the code-viewer set → `void runNavCommand(focused, monacoCommand)`; else
`focused.trigger('keyboard', monacoCommand, undefined)`.

Slice 3 adds `export function readMonacoDefaultBindings(): MonacoDefaultBinding[]` — from
`KeybindingsRegistry.getDefaultKeybindings()`: keep items with a non-null, non-`-` command, exactly
one chord, and a `when` whose `serialize()` contains `editorTextFocus` or `editorFocus`; combo via
`comboFromChord(chord, reverse of MONACO_KEY_TABLES.keyCodes, isMac)` (drop nulls); label from
`EditorExtensionsRegistry.getEditorActions()` by id, else the command id.

### `webview/editor-menu.ts` (Slice 4)

`EditorMenuContext.navHints?: Readonly<Record<string, string>>` keyed by `NAVIGATION[].actionId`;
nav row `hint = ctx.navHints?.[n.actionId] ?? n.hint`.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| `settings.shortcuts[navId]` | shortcuts-tab recorder / Reset (T2.3) | adapter hook (T1.2), code-viewer effect (T1.3), menu hints (T4.1), conflicts (T3.3), app.tsx dispatcher | Both. app.tsx dispatcher unaffected: it `continue`s on a missing `actionMap` entry in both loops (`webview/app.tsx:1074` and the bubble loop after it) — measured |
| Global Monaco rules + dispatch commands | adapter (T1.2) | Monaco resolver on every surface | Both (resolver is Monaco's; measured by Slice 1 e2e) |
| Code-viewer editor identity set | code-viewer mount (T1.3) | dispatch (T1.2) | Both |
| `conduit.<NAVIGATION.id>` keybindings | code-viewer effect (T1.3) | Monaco resolver | Both |
| Settings broadcast to other windows | host `updateSettings` → `postState` (`electron/main.ts:3447`) | each window's `useSettings` → the consumers above | Consumer only; producer unchanged, already broadcasts full settings |
| Monaco default keybinding list | `KeybindingsRegistry` (read-only) | `findConflicts` via `readMonacoDefaultBindings` (T3.2/T3.3) | Consumer only; nothing writes it |
| `monacoKeyCodeName` translation widening | monaco-keybinding (T2.1) | `monacoKeybindingFor` callers: code-viewer nextChange/prevChange effect, adapter | Both; nextChange/prevChange gain bindable keys (spec §3 says intended) |
| Nav menu hints | `navMenuHints` (T4.1) | `buildEditorMenuItems` ← code-viewer context menu | Both |
| `SHORTCUT_ACTIONS` gains 3 rows | shortcuts.ts (T1.1) | settings tab, app.tsx both loops, `comboLabel`, empty-state, editor-menu `defaultCombo`, code-viewer `comboFor` | All read by id or skip missing `actionMap`; none iterates-and-invokes without the `actionMap` guard (grep of `SHORTCUT_ACTIONS` in `webview/`) |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `webview/shortcuts.ts` | modify | `scope`/`monacoCommand` fields; 3 Code-navigation rows |
| `webview/nav-keybindings.ts` | create | pure: rule builder, override logic, conflicts, menu hints |
| `webview/monaco-keybinding.ts` | modify | widened key translation; `comboFromChord` |
| `webview/editor-combo.ts` | create | pure: editor-row capture + validation |
| `webview/monaco-nav-keybindings.ts` | create | Monaco adapter: key tables, editor set, dispatch, rule hook, default-binding read |
| `types/monaco-internal.d.ts` | modify | declarations for `keybindingsRegistry.js`, `editorExtensions.js` |
| `webview/app.tsx` | modify | call `useMonacoNavKeybindings(settings.shortcuts)` once |
| `webview/components/code-viewer.tsx` | modify | nav actions into the settings effect; editor registration; tables import; nav hints |
| `webview/components/shortcuts-tab.tsx` | create | `ShortcutsTab` + `RecorderEscape`, moved from settings-modal, plus editor-row behaviour |
| `webview/components/settings-modal.tsx` | modify | remove moved block; render `ShortcutsTab` |
| `webview/editor-menu.ts` | modify | `navHints` context field |
| `webview/styles.css` | modify | `.shortcuts__note` (refusal / named conflict line) next to `.shortcuts__conflict` (~l.8988) |
| `test/unit/nav-keybindings.test.ts` | create | U3, U4, U5, U6 |
| `test/unit/editor-combo.test.ts` | create | U2 |
| `test/unit/monaco-keybinding.test.ts` | modify | U1; `comboFromChord` |
| `test/unit/editor-menu.test.ts` | modify | `navHints` override; defaults unchanged |
| `test/e2e/nav-keybindings-surfaces.e2e.mjs` | create | Slice 1 spike: seeded overrides across surfaces |
| `test/e2e/nav-keybindings-settings.e2e.mjs` | create | Settings-UI flows, persistence, conflicts, hints |

## Scripts

None — no mechanical routine repeats across files.

## Slices

### Slice 1: Mechanism spike (H1)

**Check:** `npm run build` then `node test/e2e/run-smoke.mjs nav-keybindings-surfaces` passes
(AC-2 core, AC-3, AC-4, AC-5, AC-5b revised, AC-5c, AC-7), plus
`npx vitest run test/unit/nav-keybindings.test.ts`. **If an assertion that measures removal or
peek routing fails, STOP and report** (H1) with the failing assertion and what Monaco did.

**Parallel groups:** Serial: T1.1, T1.2, T1.3, T1.4
**Claims (serial lane):** `webview/shortcuts.ts` (T1.1), `webview/app.tsx` (T1.2)

#### Task 1.1: Data rows + pure rule builder

**Files:**
- Modify: `webview/shortcuts.ts` (interface; 3 rows after `toggleHtmlView`)
- Create: `webview/nav-keybindings.ts` (`NAV_BUILTIN_DEFAULT_CHORDS`, `navShortcutActions`,
  `canonicalCombo`, `navOverride`, `isNavOverridden`, `navDispatchCommandId`,
  `NavKeybindingRule`, `buildNavRules`)
- Test: `test/unit/nav-keybindings.test.ts`

**Interfaces:** Produces the `shortcuts.ts` and Slice-1 `nav-keybindings.ts` contracts above.

**Steps:**
- [ ] Failing tests (U4): `'buildNavRules is empty with no overrides'` — `buildNavRules({}, tb)` `== []`;
  also `== []` for `{ goToDefinition: 'F12' }` (stored default ⇒ not overridden).
  `'one override removes every default chord and adds one dispatch rule'` — for
  `{ goToDefinition: 'Alt+D' }` with a fake `tb` mapping combos to distinct numbers: rules equal
  `[{command:'-editor.action.revealDefinition', keybinding: tb('F12')}, {command:'-editor.action.revealDefinition', keybinding: tb('Mod+F12')}, {command:'conduit.dispatch.goToDefinition', keybinding: tb('Alt+D'), when:'editorTextFocus'}]`;
  References override yields one removal + one addition.
  `'swap yields both commands' rules and no leftovers'` — Definition=`Shift+F12`,
  References=`F12`: exactly 2+1 + 1+1 rules, no rule for Implementations.
  `'idempotent'` — two calls deep-equal. `'unbindable override keeps removals, adds nothing'` —
  `tb` returns null for `Alt+∂`. `'canonicalCombo orders modifiers'`. `'navShortcutActions returns
  the three rows in order with their monacoCommand'`.
- [ ] Run `npx vitest run test/unit/nav-keybindings.test.ts` — expect FAIL (module missing).
- [ ] Implement; `npx vitest related webview/shortcuts.ts webview/nav-keybindings.ts --run`;
  `npm run typecheck`.

#### Task 1.2: Monaco adapter + app mount

**Files:**
- Create: `webview/monaco-nav-keybindings.ts` (`MONACO_KEY_TABLES`, `registerCodeViewerEditor`,
  `useMonacoNavKeybindings`, private dispatch)
- Modify: `webview/app.tsx` (one `useMonacoNavKeybindings(settings.shortcuts)` call directly after
  `const { hydrate, settings, update } = useSettings();` ~l.393; one import)

**Interfaces:**
- Consumes: `buildNavRules(overrides, toBinding): NavKeybindingRule[]`,
  `navShortcutActions(): ShortcutAction[]`, `navDispatchCommandId(actionId: string): string`
  (T1.1); `monacoKeybindingFor(combo, tables): number | null`, `MonacoKeyTables`
  (`webview/monaco-keybinding.ts`); `runNavCommand(editor, commandId)` (`webview/ts-nav.ts:504`).
- Produces: `MONACO_KEY_TABLES: MonacoKeyTables`,
  `registerCodeViewerEditor(editor: monaco.editor.ICodeEditor): () => void`,
  `useMonacoNavKeybindings(shortcuts: Readonly<Record<string, string>>): void`.

**Steps:**
- [ ] Implement (proof is the Slice 1 e2e; the pure logic is already unit-tested). Two effects:
  mount → `monaco.editor.addCommand({ id: navDispatchCommandId(a.id), run: () => dispatch(a.monacoCommand) })`
  per row, dispose all on unmount; `[shortcuts]` → `const d = monaco.editor.addKeybindingRules(buildNavRules(shortcuts, (c) => monacoKeybindingFor(c, MONACO_KEY_TABLES)))`, return `() => d.dispose()`.
- [ ] `npm run typecheck`.

#### Task 1.3: Code viewer — settings-keyed nav actions, editor registration

**Files:**
- Modify: `webview/components/code-viewer.tsx`: delete `MONACO_KEY_CODES` (l.73-77) and the local
  `tables` object in the nextChange effect (~l.569) in favour of `MONACO_KEY_TABLES`; remove the
  `for (const n of NAVIGATION) editor.addAction(...)` loop from the mount effect (l.317-324, keep
  `navigate` — the context menu uses it); in the `[editor, settings.shortcuts]` effect (~l.567) add
  one `addAction` per `NAVIGATION` row — `id: conduit.${n.id}`, `label: n.label`,
  `keybindings: isNavOverridden(n.actionId, settings.shortcuts) ? [] : (NAV_KEYBINDINGS[n.actionId] ?? [])`,
  `run: () => void runNavCommand(editor, n.actionId)` — pushed into the disposed `actions` array;
  call `registerCodeViewerEditor(editor)` beside `registerNavEditor` (l.498) and invoke its
  unregister in the mount cleanup beside `unregisterNav()`. Keep `NAV_KEYBINDINGS`' doc comment
  attached to `NAV_KEYBINDINGS` (it currently sits above `MONACO_KEY_CODES`).

**Interfaces:** Consumes `isNavOverridden(monacoCommand: string, overrides): boolean` (T1.1);
`MONACO_KEY_TABLES`, `registerCodeViewerEditor(editor): () => void` (T1.2).

**Steps:**
- [ ] `npm run typecheck`; `npx vitest related webview/components/code-viewer.tsx --run`.

#### Task 1.4: Spike e2e — seeded overrides across surfaces

**Files:**
- Create: `test/e2e/nav-keybindings-surfaces.e2e.mjs` (`runScenario('nav-keybindings-surfaces', …)`)

**Fixture:** `makeNavFixture([])` from `test/e2e/nav-history-fixture.mjs` (a.ts l.12 calls
`navTarget()`, defined b.ts l.40), plus a plan written as in `test/e2e/plan-blocks.e2e.mjs`
(`.conduit/plans/` created before `openSession`, file written after) — `.conduit/plans/nav.md`
with one `ts` fence, lines:
`function localTarget(): number { return 1; }` /
`interface Shape { area(): number }` /
`class Square implements Shape { area(): number { return 2; } }` /
`const n = localTarget();`

**Helpers (in-file):**
- `setShortcuts(page, shortcuts)`: in the page, subscribe `window.agentDeck.subscribe` to capture
  the latest `state.settings` (`src/protocol.ts:369`), post `{ type: 'ready' }`, wait for it, then
  `window.agentDeck.post({ type: 'updateSettings', settings: { ...latest, shortcuts } })` and wait
  until a `state` echo carries those shortcuts.
- Caret placement in plan / peek editors through `window.monaco.editor.getEditors()` (exposed by
  `monaco-setup.ts`): pick by model content / `.peekview-widget` ancestry, `setPosition` + `focus`.
  Chords are always real `page.keyboard.press`.
- Order every step **positive-first**: assert the new chord works (polling) before asserting the
  old chord is inert (unchanged after 1 s) — the positive poll is the proof the rebuild landed.

**Steps (each logs `ACx ✓`):**
- [ ] Baseline at default: F12 on `localTarget` (plan l.4) moves the plan caret to l.1. If it
  does not, the plan-block surface can't carry AC-5 — record that and carry AC-5 on the peek
  surface only (not an H1 failure).
- [ ] `setShortcuts({ goToDefinition: 'Alt+D', goToReferences: 'Alt+R' })`.
- [ ] AC-2 core: Alt+D on a.ts l.12 → b.ts l.40 (code-viewer path). AC-3: back in a.ts, F12 inert.
- [ ] AC-4: Alt+R on the call → `.peekview-widget` visible (references peek), as Shift+F12 today.
- [ ] AC-5b (revised, see Spec staleness): focus the peek's embedded editor on `navTarget`; Alt+D →
  navigates (active tab b.ts at l.40 or the embedded caret on the definition line); F12 there inert.
- [ ] AC-5: plan block — Alt+D on `localTarget` → caret l.1; F12 inert.
- [ ] AC-5c: plan block caret on `area` in l.2, Ctrl+F12 → caret l.3 (Implementations, not
  Definition of itself); code viewer: same content in a fixture file `impl.ts` written into the root
  before `openSession`, Ctrl+F12 → caret l.3.
- [ ] AC-7: `setShortcuts({ goToDefinition: 'Shift+F12', goToReferences: 'F12' })`; Shift+F12 on
  the call → b.ts l.40; back; F12 → references peek.
- [ ] `npm run build`; `node test/e2e/run-smoke.mjs nav-keybindings-surfaces` alone. Removal or
  routing failure ⇒ STOP (H1). The diff viewer is not an e2e surface (anonymous-URI models make
  its navigation outcome language-dependent); it shares the global rules, covered by U4.

### Slice 2: Recording editor rows in Settings

**Check:** `npx vitest run test/unit/monaco-keybinding.test.ts test/unit/editor-combo.test.ts`;
then `npm run build` and `node test/e2e/run-smoke.mjs nav-keybindings-settings` (AC-1, AC-2,
AC-6, AC-8, AC-9).

**Parallel groups:** Serial: T2.1, T2.2, T2.3, T2.4
**Claims (serial lane):** `webview/components/settings-modal.tsx`, `webview/styles.css` (T2.3)

#### Task 2.1: Widen Monaco key translation (U1)

**Files:** Modify `webview/monaco-keybinding.ts` (export `monacoKeyCodeName`, extended table);
Test `test/unit/monaco-keybinding.test.ts`.

**Interfaces:** Produces `monacoKeyCodeName(token: string): string | null`.
**Call sites:** `monacoKeybindingFor` (internal); its callers `code-viewer.tsx` nextChange effect and
`monaco-nav-keybindings.ts` are unchanged in signature.

**Steps:**
- [ ] Failing test `'translates arrows, nav keys and unshifted punctuation with every modifier'` —
  table-driven over every new token × {none, Mod, Ctrl, Alt, Shift, Mod+Alt+Shift}:
  `monacoKeybindingFor(combo, fakeTables) == code | mods`; `'refuses shifted punctuation and the
  digit family'` — `'Shift+>'`, `'Ctrl+1…9'` → `null`.
- [ ] Run — FAIL (tokens unmapped). Implement.

#### Task 2.2: Editor-row capture + validation (U2)

**Files:** Create `webview/editor-combo.ts`; Test `test/unit/editor-combo.test.ts`.

**Interfaces:** Consumes `monacoKeyCodeName(token: string): string | null` (T2.1),
`KeyEvt` (`webview/shortcuts.ts`). Produces `editorComboFromEvent(e: KeyEvt, mac: boolean)`,
`validateEditorCombo(combo: string): string | null`.

**Steps:**
- [ ] Failing tests: `'refuses typing chords'` — `D`, `Shift+D`, `Enter`, `Tab`, `Space`,
  `Backspace`, `Delete`, `.` → `'This key types text in the editor'`; `'refuses unbindable'` — `Mod+>`,
  `Ctrl+1…9` → `"This key can't be bound in the editor"`; `'accepts'` `F12`, `Alt+D`, `Mod+Shift+ArrowDown`, `Ctrl+F12`, `ArrowUp`
  → `null`; `'mac ⌥D records the letter from keyCode'` —
  `editorComboFromEvent({altKey:true,key:'∂',code:'KeyD',keyCode:68}, true) == 'Alt+D'`;
  `'AZERTY records the key Monaco resolves'` — `({ctrlKey:true,key:'a',code:'KeyQ',keyCode:65}, false) == 'Mod+A'`;
  modifier-only → `null`; `({ctrlKey:true,key:'5',code:'Digit5'}, false) == 'Mod+1…9'`.
- [ ] Run — FAIL. Implement.

#### Task 2.3: Extract ShortcutsTab; editor-row recording

**Files:**
- Create: `webview/components/shortcuts-tab.tsx` — `export function ShortcutsTab({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void })` plus private `RecorderEscape`, moved verbatim from `settings-modal.tsx` l.1008-1090 (port: existing behaviour must be byte-identical for app rows), then extended.
- Modify: `webview/components/settings-modal.tsx` — delete the moved block and now-unused imports;
  l.126 renders `<ShortcutsTab settings={settings} update={update} />`.
- Modify: `webview/styles.css` — `.shortcuts__note` (muted-text token, `--font-scale` sizing,
  wraps under the label, never truncates).

**Interfaces:** Consumes `editorComboFromEvent`, `validateEditorCombo` (T2.2);
`canonicalCombo`, `navOverride` (T1.1); `comboFromEvent`, `effectiveCombo`, `formatCombo`, `isMac`,
`SHORTCUT_ACTIONS` (`webview/shortcuts.ts`).

**Behaviour (editor rows = `scope === 'editor'`):**
- Capture with `editorComboFromEvent(e, isMac)`; `null` → keep waiting. Reason from
  `validateEditorCombo` → stay recording, render `<div className="shortcuts__note">{reason}</div>`
  under the row, announce it. Valid → if `canonicalCombo(combo) === canonicalCombo(defaultCombo)`
  delete the override, else store it; end recording. App rows: exactly today's path.
- Refusal state clears when recording ends or moves to another row.
- Stored override that fails `validateEditorCombo` → row shows it plus
  `· can't be bound in the editor`.
- Reset visible iff `navOverride` (editor rows) / `overrides[id]` (app rows).
- `aria-label` on every row: Record → `Record shortcut for ${description}`; Reset →
  `Reset ${description} to ${formatCombo(defaultCombo)}`.
- One visually hidden polite region `<div className="sr-only" aria-live="polite">` (existing
  `.sr-only`, `styles.css:11795`) announcing: `Recording shortcut for X. Press keys, Escape to
  cancel.` / `X set to <formatted>` / the refusal reason / `X reset to <formatted default>`.
- Conflict display stays today's boolean in this slice (Slice 3 replaces it).

**Steps:**
- [ ] Move first, `npm run typecheck`, `npx vitest related webview/components/settings-modal.tsx --run` (port proof), then extend.
- [ ] Visual: screenshot the Shortcuts tab (recording + refusal + overridden rows) in the three
  themes to `%TEMP%\claude-scratch\`, check wrap and contrast, delete after.

#### Task 2.4: Settings e2e

**Files:** Create `test/e2e/nav-keybindings-settings.e2e.mjs` — uses `launchApp`/`closeApp`
directly (like `test/e2e/shortcut-precedence.e2e.mjs`) so AC-9 can relaunch on the same
`userDataDir`; fixture `makeNavFixture([])`; open Settings via `Mod+,` and its Shortcuts tab.

**Steps:** AC-1 (group "Code navigation" after "Editor", rows `F12`, `Ctrl + F12`, `Shift + F12`);
AC-2 (set `window.__navMarker = 1`, record Alt+D, close Settings, Alt+D → b.ts l.40, marker
survives); AC-8 (Record, press `d` → still "Press keys…" and `This key types text in the editor`;
Escape → `F12`); AC-6 (Reset → F12 navigates, then Alt+D inert); AC-9 (record Alt+D, `closeApp`,
relaunch same dir → row `Alt + D`, Alt+D navigates). Run alone after `npm run build`.

### Slice 3: Conflict notes

**Check:** `npx vitest run test/unit/nav-keybindings.test.ts test/unit/monaco-keybinding.test.ts`;
`npm run build`; `node test/e2e/run-smoke.mjs nav-keybindings-settings` (with the conflict step).

**Parallel groups:** Serial: T3.1, T3.2, T3.3 (T3.2 imports T3.1's `MonacoDefaultBinding` type)
**Claims (serial lane):** `types/monaco-internal.d.ts` (T3.2)

#### Task 3.1: findConflicts (U3, U6)

**Files:** Modify `webview/nav-keybindings.ts` (`MonacoDefaultBinding`, `Conflict`,
`CODE_VIEWER_CHORDS`, `findConflicts`); Test `test/unit/nav-keybindings.test.ts`.

**Interfaces:** Produces the Slice-3 `nav-keybindings.ts` contracts (verbatim above).

**Steps:**
- [ ] Failing tests: U3 `'app conflict'` — Definition=`Mod+P` → `{kind:'app', actionId:'openSearch', label:'Search files & sessions', editorScoped:false}`;
  `'monaco default conflict'` — injected `[{command:'editor.action.commentLine', label:'Toggle Line Comment', combo:'Mod+/'}]`, Definition=`Mod+/` → one `monaco` conflict;
  `'never against its own default'` — injected `{command:'editor.action.revealDefinition', combo:'F12'}`, no overrides → `[]` for goToDefinition;
  `'removed chord no longer reported'` — Definition=`Alt+D`, References=`F12` with that injected list → no `monaco` conflict for goToReferences;
  U6 `'code-viewer chords'` — Definition=`Alt+Z` → `{kind:'codeViewer', label:'Toggle Word Wrap'}`;
  `'app rows get only app conflicts'` — `openSearch` with a colliding injected default → none.
- [ ] Run — FAIL. Implement.

#### Task 3.2: Read Monaco's default bindings

**Files:** Modify `webview/monaco-keybinding.ts` (`comboFromChord`) + `test/unit/monaco-keybinding.test.ts`;
Modify `webview/monaco-nav-keybindings.ts` (`readMonacoDefaultBindings`); Modify
`types/monaco-internal.d.ts`:

```ts
declare module 'monaco-editor/esm/vs/platform/keybinding/common/keybindingsRegistry.js' {
  export interface KeybindingChordLike { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; keyCode: number }
  export interface KeybindingItemLike {
    command: string | null;
    keybinding: { chords: KeybindingChordLike[] } | null;
    when: { serialize(): string } | null | undefined;
  }
  export const KeybindingsRegistry: { getDefaultKeybindings(): KeybindingItemLike[] };
}
declare module 'monaco-editor/esm/vs/editor/browser/editorExtensions.js' {
  export const EditorExtensionsRegistry: { getEditorActions(): { id: string; label: string }[] };
}
```

**Interfaces:** Produces `comboFromChord(chord, keyCodeNames, mac): string | null`,
`readMonacoDefaultBindings(): MonacoDefaultBinding[]`. Consumes the `MonacoDefaultBinding` type
from T3.1 (`webview/nav-keybindings.ts`) — imported, never redeclared.

**Steps:**
- [ ] Failing test `'comboFromChord round-trips monacoKeybindingFor'` — `{ctrlKey:true,shiftKey:false,altKey:false,metaKey:false,keyCode:<Slash>}` with `mac:false` → `'Mod+/'`; mac `{metaKey:true,ctrlKey:true,…KeyK}` → `'Mod+Ctrl+K'`; off-mac `metaKey` → `null`.
- [ ] Implement; `npm run typecheck`.

#### Task 3.3: Conflict notes in ShortcutsTab

**Files:** Modify `webview/components/shortcuts-tab.tsx`; extend `test/e2e/nav-keybindings-settings.e2e.mjs`.

**Interfaces:** Consumes `findConflicts(actionId, overrides, monacoDefaults): Conflict[]` (T3.1),
`readMonacoDefaultBindings(): MonacoDefaultBinding[]` (T3.2, read once via `useMemo(…, [])`).

**Behaviour:** app rows: ` · conflict` iff `findConflicts` returns any (replaces the old boolean).
Editor rows, one `shortcuts__note` per conflict: app/non-editor → `· conflict: overrides <label>
while editing`; app/editor → `· conflict: <label>`; monaco/codeViewer → `· shadows <label> in the
editor`. Text, `--red` token for the conflict class, never colour alone.

**Steps:** e2e step — record Definition = `Mod+P` → note contains `overrides Search files &
sessions while editing` and the Search row shows `· conflict`; record `Alt+Z` → `shadows Toggle
Word Wrap in the editor`; Reset. Also record the winner of Alt+Z in the code viewer (edge case §4
"build states which one wins") in the handoff report.

### Slice 4: Context-menu hints

**Check:** `npx vitest run test/unit/nav-keybindings.test.ts test/unit/editor-menu.test.ts`;
`npm run build`; `node test/e2e/run-smoke.mjs nav-keybindings-settings` (AC-10 step).

**Parallel groups:** Serial: T4.1

#### Task 4.1: navMenuHints (U5) + editor-menu + code-viewer

**Files:** Modify `webview/nav-keybindings.ts` (`navMenuHints`), `webview/editor-menu.ts`
(`navHints`), `webview/components/code-viewer.tsx` (context-menu build ~l.343 passes
`navHints: navMenuHints(shortcutsRef.current, formatCombo)`); Tests
`test/unit/nav-keybindings.test.ts`, `test/unit/editor-menu.test.ts`; extend
`test/e2e/nav-keybindings-settings.e2e.mjs`.

**Interfaces:** Produces `navMenuHints(overrides, format): Record<string, string>`.
**Call sites:** `buildEditorMenuItems` — only `code-viewer.tsx`; existing tests pass no `navHints`
and keep today's hints.

**Steps:**
- [ ] Failing tests: U5 `'hints follow the effective combo'` — `navMenuHints({goToDefinition:'Alt+D'}, (c) => c.replace(/\+/g,' + '))` → `{'editor.action.revealDefinition':'Alt + D', 'editor.action.goToImplementation':'Mod + F12', 'editor.action.goToReferences':'Shift + F12'}`; editor-menu `'navHints override the static hint'`.
- [ ] Implement; e2e AC-10: Definition=Alt+D, right-click a symbol in a.ts → "Go to Definition" row hint `Alt + D`.

## Verification

- Per task: named unit test(s) red → green; `npx vitest related <files> --run`; `npm run typecheck`.
- Per slice: its Check, e2e scenarios run **alone** after `npm run build`.
- Before handoff (once): `npm run verify *> "$env:TEMP\claude-scratch\verify.log"; $LASTEXITCODE`
  → 0; AC-11: `node test/e2e/run-smoke.mjs editor-nav-history` and, only if `gopls` is on PATH,
  `node test/e2e/run-smoke.mjs go-lsp`. Diff viewer: one manual check in the built app (Definition
  = Alt+D, F12 inert / Alt+D runs in a TS diff) reported in the handoff, per spec §7.
- `git status` shows only the File-map paths.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. Report leads with the fix that keeps the locked decision. For Slice 1 in
particular: a removal rule Monaco ignores, or a peek chord that routes wrongly, ends the item (H1).

## Decisions Needed

- [normal] AC-5b re-targeted from References to Definition (References is disabled in peek editors
  by Monaco's own precondition) — default taken: Definition. Build finding: in a peek, F12 is also
  Monaco's `goToNextReference`, live once Definition's F12 is removed, so AC-5b asserts "F12 does
  not run Definition" rather than "F12 is inert".
- [resolved in review] Nav menu hints use Monaco's compact style (`Alt+D`, `formatMonacoHint`) to
  match the Monaco-derived hints beside them; Settings keeps `formatCombo`'s `Alt + D`.
- [resolved in review] Monaco default bindings reach the Shortcuts tab through a lazy `import()`
  (with a logged catch): a static import put `monaco-editor` into `settings-modal.tsx`'s module
  graph and broke the jsdom test that imports it.
- [normal] `Space` added to the translatable/capturable keys (spec §3 list omits it, but `keyCode`
  capture needs a token for it; bare Space is refused as typing) — default taken: include.
- [normal] `CODE_VIEWER_CHORDS` is a static mirror of code-viewer's Save/Word-Wrap numeric
  bindings rather than their source — default taken: mirror (making it the source means rewriting
  those registrations, out of scope).
- [normal] The `Shortcuts` tab is extracted to `shortcuts-tab.tsx` to keep the auto-save sibling's
  `settings-modal.tsx` merge mechanical — default taken: extract.
