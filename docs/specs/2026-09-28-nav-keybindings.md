---
status: active
date: 2026-09-28
---

# Feature Spec: Configurable code-navigation shortcuts

**Tier:** FULL   **Feature type:** UI
**Mode:** autonomous: no human in the loop. Would-be questions are assumptions (§12) or
flagged decisions (§13).
**One-line request:** "we need configurable shortcuts for the following items: Go to definition,
Go to implementation, Go to references."

Triage: FULL because the change crosses three editor surfaces (code viewer, diff viewer, plan code
blocks, plus Monaco's peek widgets), two keybinding systems (Conduit's app dispatcher and Monaco's
keybinding service), and the Settings UI.

## 0. What already exists (inventory)

Most of the surface is already there. This feature **extends it**. It does not build a new one.

- **A user-configurable shortcut surface exists.** Settings → **Shortcuts** tab
  (`webview/components/settings-modal.tsx` `Shortcuts`). It lists every `SHORTCUT_ACTIONS` entry
  (`webview/shortcuts.ts`) by group, with **Record** (captures the next non-modifier keydown via
  `comboFromEvent`; Escape cancels through the overlay stack's `RecorderEscape`) and **Reset**
  (shown only when overridden). It marks a row "· conflict" when another action has the same
  effective combo.
- **Persistence:** `AppSettings.shortcuts: Record<actionId, combo>` (`src/settings.ts`): only
  overrides are stored, and the default comes from `defaultCombo`. The field is already persisted
  and validated as a string map (`strMap`).
- **Combo grammar:** `Mod` means Ctrl on Windows/Linux and ⌘ on macOS. `Ctrl` is the literal control
  key. Other tokens are `Alt`, `Shift` and the key. `formatCombo` renders per platform.
- **Editor-scoped precedent:** `nextChange`/`prevChange` are rebindable. `code-viewer.tsx`
  translates the effective combo with `monacoKeybindingFor` (`webview/monaco-keybinding.ts`) and
  re-registers its `addAction` whenever `settings.shortcuts` changes. That translation only covers
  `F1–F24`, `A–Z` and `0–9`, and returns `null` for any other key.
- **The three nav commands are NOT in `SHORTCUT_ACTIONS`.** Their bindings are hard-coded in
  `code-viewer.tsx` `NAV_KEYBINDINGS`: `revealDefinition` F12, `goToImplementation` CtrlCmd+F12,
  and `goToReferences` Shift+F12. Peek Definition (Alt+F12) and Find All References
  (Shift+Alt+F12) are also hard-coded there. The code viewer registers each of them as a
  `conduit.<id>` editor action whose `run` calls `runNavCommand` (`webview/ts-nav.ts`).
  `runNavCommand` picks the LSP path (`runLspNav`, used for gopls and others) or the TS-worker path
  **by language**, so a single keybinding covers both paths. The context menu's accelerator hints
  are static strings in `editor-menu.ts` `NAVIGATION` (`hint: 'F12'`, etc.).
- **Monaco's built-in commands carry the same default chords**, registered globally through
  `registerAction2`. The diff viewer (`diff-viewer.tsx`) and the plan editors
  (`plan-code-block.tsx`, `plan-view.tsx`) register no `conduit.*` nav actions, so on those
  surfaces F12 and the other chords reach Monaco's built-in commands directly and do not go through
  `runNavCommand`.
- **`revealDefinition` has a second default:** `CtrlCmd+F12` when `isWeb`
  (`contrib/gotoSymbol/browser/goToCommands.js` ~l.239). `isWeb` is true in our renderer, so on
  built-in surfaces Ctrl+F12 is bound to both Definition and Implementations today. The built-ins'
  keybinding `when` is ANDed with their precondition (`hasDefinitionProvider` etc.). On a surface
  with no provider, the chord therefore falls through to the app dispatcher.
- **The code-viewer nav actions are registered once**, in the mount effect from `NAV_KEYBINDINGS`
  (~l.318). `nextChange` is different: it lives in the `[editor, settings.shortcuts]` effect
  (~l.563). The nav actions must move into a settings-keyed effect.
- **The static `NAVIGATION` hint `'Ctrl+F12'` is already wrong on macOS**, where it should read
  ⌘ + F12. Deriving hints from the effective combo fixes it.
- **Ctrl/Cmd+click** is a separate `onMouseDown` path in `code-viewer.tsx`. It is out of scope.

### Current behavior

| Claim about today's behavior | How it was measured | Measured / ASSUMED |
|---|---|---|
| F12 in the code viewer navigates cross-file to the definition | `npm run build` then `node test/e2e/run-smoke.mjs editor-nav-history` on HEAD `beb4253`, 2026-09-28: 3/3 PASS (AC1 "F12" lands in `b.ts:40`) | Measured |
| Shift+F12 in the code viewer opens references for a gopls file | `test/e2e/go-lsp.e2e.mjs` asserts it. Not run this session (needs gopls) | ASSUMED |
| Ctrl+F12 in the code viewer runs Go to Implementations | No e2e presses it. Inferred from `NAV_KEYBINDINGS` | ASSUMED |
| In code-viewer editors, F12 reaches `conduit.goToDefinition` (so `runNavCommand`) rather than Monaco's built-in | Inferred: editor `addAction` keybindings are dynamic (override-priority) rules scoped by `editorId` (`standaloneCodeEditor.js:108`), and override rules outrank registry defaults | ASSUMED |
| In the diff viewer and plan blocks, F12 reaches Monaco's built-in command, and whether it navigates is language/URI-dependent (diff models are anonymous URIs) | Inferred from source | ASSUMED |
| Inside a peek widget's embedded editor, F12 reaches Monaco's built-in (own `editorId`, so `conduit.*` never fires there); the embedded editor is built through the parent's scoped instantiation service (`referencesWidget.js` ~l.303) and so likely INHERITS the parent's context keys | Inferred from source | ASSUMED |
| On diff/plan surfaces, Ctrl+F12 runs Definition or Implementations (two defaults collide) | Not measured | ASSUMED |
| Monaco 0.55.1's `editor.addKeybindingRules` accepts a `-commandId` removal rule that removes a default chord; with no `when`, it removes every `when` variant of that chord | Read from source: rules become `_dynamicKeybindings`, normalised as overrides in `StandaloneKeybindingService.updateResolver`; `KeybindingResolver.handleRemovals` (`keybindingResolver.js` ~l.74-112) applies `-` overrides against `isDefault` items | ASSUMED until AC-5 runs (source-read, not measured) |
| Closing the modal / switching tab mid-recording saves nothing (the recorder's listener is removed on unmount) | Inferred from `Shortcuts`' effect cleanup | ASSUMED |

## 1. Problem frame

- **Job:** a user whose muscle memory differs from VS Code's F-key layout (such as a JetBrains user
  who presses Ctrl+B, or a laptop user without comfortable F-keys) wants definition,
  implementation and reference navigation on their own chords, **in every editor where those
  commands work**.
- **Actors:** a single local user. Settings sync to every open window through the existing
  settings broadcast.
- **Success outcomes:**
  - The three commands appear in Settings → Shortcuts with their real current chord.
  - Recording a new chord makes that chord navigate in the focused editor at once. There is no
    reload and no tab reopen.
  - The old chord stops triggering the command.
  - Reset restores today's behavior exactly.
  - The context-menu hints show the effective chord.
- **Non-goals:** a general keybindings editor, `when` clauses, and multi-chord sequences
  (Ctrl+K Ctrl+D). Also out: rebinding Monaco's other commands, Peek Definition, Find All
  References, Go to Type Definition, and Ctrl/Cmd+click. Keybinding import and export are out, and
  so are several chords per command.

## 2. Behavior & states

**Primary flow**

1. The user opens Settings → Shortcuts. A new group, **Code navigation**, appears after
   **Editor**. It has three rows:

   | Row | Default combo |
   |---|---|
   | Go to Definition | `F12` |
   | Go to Implementations | `Mod+F12`, displayed as `Ctrl + F12` or `⌘ + F12` |
   | Go to References | `Shift+F12` |

2. The user clicks **Record** on a row. The chip reads "Press keys…". The next non-modifier keydown
   is validated (§3). If valid, it is saved as an override and the row shows it. If invalid, the row
   stays in recording mode and shows an inline reason.
3. **Live application:** once the override lands in `settings.shortcuts`, every open editor on
   every surface (§2.2) responds to the new chord and stops responding to the old one.
4. **Reset** deletes the override. The default chord works again and the custom chord stops.

### 2.1 States per row

`default` → (Record) → `recording` → (valid key) → `overridden` | (invalid key) → `recording+error`
| (Escape or leaving the tab or modal) → back to the prior state. From `overridden`, Reset leads to
`default`. Either state may also be `conflicting` (a warning overlay; §4). Only one row records at a
time: clicking Record on another row moves recording to it.

### 2.2 Which editors honour the binding

| Surface | Command that runs on the effective chord | Required behavior |
|---|---|---|
| Code viewer (file tab, editable) | `runNavCommand`, covering the TS and LSP paths | New chord runs it. Old chord is inert |
| Diff viewer, both sides (read-only) | Monaco built-in `editor.action.*` | New chord triggers the built-in. None of the old default chords do |
| Plan code blocks and plan source view | Monaco built-in | Same as the diff viewer |
| Peek widget embedded editor, including a peek opened inside a code viewer | Monaco built-in, on the embedded editor | Same as the diff viewer. The embedded editor likely inherits the parent's context keys, so routing must key on the focused editor's identity, not on a context key |
| Any future editor surface (e.g. split editor, `docs/specs/2026-09-28-split-editor.md`) | Inherits whichever rule set it uses | A split pane that is a code viewer gets the `conduit.*` path for free |

Whether the built-in *navigates successfully* on the diff, plan and peek surfaces is unchanged by
this feature. Only the chord changes. Routing those surfaces through `runNavCommand` is out of
scope.

**Mechanism (behavioral level; the plan owns the details):**

- **Global rule set (one owner per window):** a single place holds a disposable set of Monaco
  keybinding rules and rebuilds it on every change of the three effective combos. For each command
  whose combo differs from its default, it adds two kinds of rule:
  - an **unconditioned removal of every default chord** of the built-in. For Definition that is
    F12 and also the `isWeb` Ctrl+F12. For Implementations it is Ctrl+F12, and for References it is
    Shift+F12.
  - the new chord, with `when: editorTextFocus`, bound to a **Conduit dispatch command**, one per
    nav action.

  The dispatch command looks at the focused editor:
  - if it is a registered code-viewer editor, it calls `runNavCommand(editor, builtinId)`;
  - otherwise (the diff, plan or peek embedded editor), it runs the built-in on that editor.

  Keying on the identity of the focused editor is what makes a peek inside a code viewer work. The
  rule has no precondition, so the chord never falls through to the app dispatcher on a surface
  with no provider. At default, the set is empty, which is today's behavior byte for byte. N6
  records the alternative, which is to always route through the dispatch command.
- **Code viewer:** its `conduit.*` nav actions stay, so the palette and the context menu keep
  working. Registration moves into the `[editor, settings.shortcuts]` effect. An action binds its
  chord only while that chord is the default. When it is overridden, the action has no keybinding,
  and the global dispatch rule owns the chord. That leaves exactly one live rule per chord.
- **App dispatcher:** the three actions get **no** `actionMap` entry in `app.tsx`. They are
  editor-scoped only, so pressing the chord outside an editor does nothing and the key falls
  through. The dispatcher already skips an action with no `actionMap` entry.

## 3. Data / interface contract

- **Data shape (extensible):** add three entries to `SHORTCUT_ACTIONS`, with ids `goToDefinition`,
  `goToImplementation` and `goToReferences`, and `group: 'Code navigation'`. Add two optional fields
  to `ShortcutAction`:
  - `scope?: 'app' | 'editor'`. Absent means `'app'`.
  - `monacoCommand?: string`. This is the built-in id (`editor.action.revealDefinition`,
    `editor.action.goToImplementation`, `editor.action.goToReferences`) and also the key into
    `NAVIGATION`/`runNavCommand`.

  Later commands (peek, type definition, find-all-refs) are added by appending entries. Nothing
  else changes shape. **No change** to `AppSettings`, the persisted file or `strMap`.
- **Input validation** is a pure function, `validateEditorCombo(combo) → ok | reason`, applied only
  to `scope: 'editor'` rows. It refuses:
  1. a combo `monacoKeybindingFor` cannot translate, with the reason "This key can't be bound in
     the editor";
  2. the `1…9` digit-family token, with the same reason;
  3. a "typing" chord: a key with no modifier or Shift only that is a printable character or
     Enter, Tab, Backspace, Space or Delete. The reason is "This key types text in the editor".

  Bare F-keys and navigation keys (arrows, Home/End, PageUp/PageDown) with no modifier are allowed.
  App-scope rows keep today's permissive recorder unchanged. The shared recorder takes a per-row
  validator. Only editor rows pass one.
- **Key-code capture for editor rows (N7, re-locked after review):** the key token is derived from
  `e.keyCode` rather than `e.key` (65–90 → `A`–`Z`, 48–57 → `0`–`9`, the OEM codes 186 `;` 187 `=`
  188 `,` 189 `-` 190 `.` 191 `/` 192 `` ` `` 219 `[` 220 `\` 221 `]` 222 `'`, 32 → `Space`); named
  keys (F12, arrows, Home…) come from `e.key`, and modifiers are read as today. There are two
  reasons:
  - on macOS, ⌥D produces `e.key = '∂'`, which would record `Alt+∂` and be refused; its `keyCode`
    is still 68, so it records `Alt+D`;
  - Monaco resolves a keydown from `e.keyCode` (`keyboardEvent.js` `extractKeyCode` →
    `standaloneServices` `resolveKeyboardEvent` → `USLayoutResolvedKeybinding`), so a token taken
    from `keyCode` names the chord that will actually fire. An earlier draft used `e.code` (the
    physical US position); on AZERTY that records `Mod+Q` for the key Monaco resolves as `Mod+A`.

  App rows keep `e.key`.
- **Translation coverage:** extend `monacoKeybindingFor` from F/letters/digits to the keys
  `comboFromEvent` emits that Monaco has codes for:
  - arrows (`ArrowLeft` → `LeftArrow` …);
  - Home, End, PageUp, PageDown, Insert, Delete, Enter, Tab, Escape, Backspace;
  - US-layout punctuation that appears unshifted (`` ` `` `-` `=` `[` `]` `\` `;` `'` `,` `.` `/`).

  A shifted punctuation `e.key` (for example `>` from Shift+.) stays untranslatable and is refused
  by rule 1. Extending the translation also benefits `nextChange`/`prevChange`.
- **Conflict detection** is a pure function, `findConflicts(actionId, effective, monacoDefaults) →
  Conflict[]`, that returns:
  - **App conflict:** another `SHORTCUT_ACTIONS` entry with the same effective combo. This rule
    exists today.
  - **Editor conflict**, for `scope: 'editor'` rows only: a Monaco default keybinding on a
    *different* command with the same chord. The default keybinding list is read once from Monaco's
    keybinding registry at runtime and injected, so the function stays node-testable. It is limited
    to rules whose `when` references editor focus (`editorTextFocus`/`editorFocus`). The three nav
    commands' own defaults are excluded, and so are chords the global rule set has removed.
  - **Conduit editor conflict**, for `scope: 'editor'` rows only: the code viewer's own
    `addAction`/`addCommand` chords that are not app rows. Today these are `Mod+S` Save and `Alt+Z`
    Toggle Word Wrap. They come from a static list exported next to `NAV_KEYBINDINGS`, and the
    registry never sees them.
- **Normalisation (editor rows only):** recording a combo equal to the row's default deletes the
  override instead of storing it.
- **Outputs:** the row's displayed combo, the context-menu `hint` for the three `NAVIGATION` rows
  (derived from the effective combos, not the static strings), and Monaco's own palette/label
  rendering, which follows the resolver automatically.
- **Invariants:**
  - With no overrides, the Monaco rule set is empty and the `conduit.*` bindings equal today's
    `NAV_KEYBINDINGS`.
  - An overridden command has none of its default chords live on any surface. That includes
    Definition's `isWeb` Ctrl+F12.
  - At most one chord per command is live at a time.
  - The same `settings.shortcuts` value always yields the same rule set (idempotent rebuild, all
    old disposables disposed).

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `settings.shortcuts[navId]` | Settings recorder / Reset | code-viewer action registration; global Monaco rule owner; context-menu hints; conflict display | Yes |
| Monaco global keybinding rules and dispatch commands | Global rule owner (new) | Monaco keybinding resolver, used on every surface | Yes |
| Registry of code-viewer editors | code-viewer mount/unmount (new) | Dispatch command | Yes |
| `conduit.*` editor keybindings (default chords only) | code-viewer | Monaco resolver for that editor | Yes |
| Settings broadcast to other windows | Host settings persistence (existing) | Each window's settings provider → the two producers above | Yes (existing path, unchanged) |
| Monaco default keybinding list | Monaco `KeybindingsRegistry` (read-only) | `findConflicts` | Yes (read-only, no change to producer) |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Two nav rows set to the same chord | Both show "· conflict". The code viewer runs whichever action Monaco resolves last. Allowed (warn, not block), matching the existing app-row policy |
| Nav chord equals an app shortcut (e.g. `Mod+P`) | Both rows show "· conflict". While an editor has text focus, the nav command wins on every surface: the dispatch rule has no provider precondition, so Monaco always consumes the key. Elsewhere, the app shortcut fires. The note says "overrides <app action> while editing" |
| Nav chord equals a Monaco editor default (e.g. `Mod+/` toggle comment) or a code-viewer chord (`Mod+S`, `Alt+Z`) | The row shows "· shadows <label> in the editor". The dispatch rule is an override, so it wins over Monaco defaults. Against code-viewer `addAction` chords the winner is ASSUMED to be the later-registered rule, and the build states which one wins |
| Nav chord on a surface with no provider (plain-text diff) | The chord is consumed, the built-in runs, and nothing happens. The app shortcut sharing that chord does not fire |
| Recording a combo that the rule set previously removed for another nav command's default (swap F12 ↔ Shift+F12) | The rebuild is computed from the full effective set, so a chord both removed (as the old default) and added (as the new chord) resolves to the new command. AC-7 covers this |
| Chord is untranslatable, a digit family or a typing chord | Refused inline (§3). The row stays in recording. Escape exits |
| Modifier-only keydown | Ignored. Keeps waiting (existing) |
| Recording is active and the user closes the modal or switches tab | Recording is cancelled and nothing is saved. The unmount removes the listener. This is ASSUMED (§0), and the build confirms it |
| Settings change while an editor has a peek or suggest widget open | Rules rebuild. The open widget is unaffected. The next keypress uses the new rules |
| Many editors open (tabs, split panes, plan blocks) | Global rules are per window, not per editor, so there is one rebuild. Code-viewer editors each re-register 3 actions: O(editors), trivial |
| Second window open | It receives the settings broadcast and applies the same rebuild |
| Stored override is malformed or untranslatable (hand-edited settings) | Treated as no binding for the editor: no `conduit.*` chord and no global addition. The default removal is **still** applied so the default doesn't silently come back. The row shows the stored combo with "· can't be bound". Reset recovers |
| Stored override equals the default | Normalise at write time: recording the default chord deletes the override, so Reset stays hidden |
| macOS | `Mod` records ⌘, and the default `Mod+F12` means ⌘F12, matching Monaco's CtrlCmd. `Ctrl` on mac maps to `WinCtrl` (existing). ⌥+letter records the letter from `keyCode` (`Alt+D`), not `∂` |
| Non-US layout (AZERTY, Dvorak) | Editor rows record the key from `e.keyCode`, which is what Monaco resolves the chord on, so the recorded chord is the one that fires (AZERTY Ctrl+A records `Mod+A`) |
| Monaco refuses a `-command` removal rule (AC-5 fails) | Stop and escalate. The fallback (overriding the default chord with a no-op rule on the built-in's chord) is a design change for the plan, not a silent substitute |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Go to Definition | `F12` | Yes | Today's binding and VS Code parity |
| Go to Implementations | `Mod+F12` | Yes | Today's binding (Monaco CtrlCmd+F12) |
| Go to References | `Shift+F12` | Yes | Today's binding |
| Conflicts | Warn, allow | No | Matches existing Shortcuts policy; a user may deliberately shadow |
| Typing / untranslatable chords | Refuse | No | A bare letter would break typing in every editor |
| Scope of a nav chord | Editor focus only | No | These commands need a cursor in an editor |
| Group placement | New "Code navigation" group after "Editor" | No | Keeps the Editor group from growing into a mixed list; §13 N1 |

## 6. Scope slicing

- **MVP:**
  - the three rows;
  - the extended data shape;
  - validation, key-code capture for editor rows and the extended translation;
  - code-viewer live rebinding;
  - the global rule set covering the diff, plan and peek surfaces;
  - default removal;
  - context-menu hints from the effective combos;
  - app and Monaco conflict display;
  - unit and e2e coverage.
- **v1:** add Peek Definition, Find All References and Go to Type Definition by appending entries.
- **Vision:** a searchable keybindings list covering Monaco's own commands, "remove binding", and
  multiple chords per command.
- **Out of scope:**
  - Ctrl/Cmd+click;
  - routing diff, plan and peek navigation through `runNavCommand`;
  - chord sequences;
  - changing the app-row recorder's permissiveness;
  - the Command palette's (`Mod+Shift+P`) listing of these commands. Today it has no rows for them;
    adding rows is v1.

## 7. Acceptance criteria

Unit (vitest, `test/unit/`, platform-independent: pass `isMac` or inject it, never read
`process.platform`):

- U1. `monacoKeybindingFor` translates every newly covered key (arrows, nav keys, the listed
  punctuation) with each modifier combination, and returns `null` for shifted punctuation and the
  digit family.
- U2. `validateEditorCombo` refuses the three classes in §3 and accepts `F12`, `Alt+D`,
  `Mod+Shift+ArrowDown` and `Ctrl+F12`. The editor-row capture function, given a mac event
  `{altKey, key:'∂', code:'KeyD', keyCode:68}`, yields `Alt+D`, and given an AZERTY `{ctrlKey,
  key:'a', code:'KeyQ', keyCode:65}` yields `Mod+A`.
- U3. `findConflicts` reports an app conflict, a Monaco-default conflict (on an injected list), and
  none against the command's own default. With a removal in effect it no longer reports that
  removed chord.
- U4. The pure rule-set builder (effective combos → rules) returns `[]` for no overrides. For
  one override it returns a removal for **each** default chord of that command (two for Definition,
  F12 and Ctrl+F12; one for the others) plus one dispatch-command addition. For a swap it returns
  the rules for both commands with no leftovers, and it is idempotent.
- U6. `findConflicts` reports the code-viewer chords (`Mod+S`, `Alt+Z`) for editor rows.
- U5. The `NAVIGATION` hint derivation returns the effective, platform-formatted combo.

EARS:

- When the user records a valid chord for a nav row, the app shall persist it and bind it in
  every open editor surface without a reload or a tab reopen. The first keypress after Settings
  closes uses the new chord.
- When a nav row is overridden, the app shall not run that command on its default chord in any
  editor surface.
- If the recorded chord is refused, then the row shall stay in recording and show the reason in
  text (not colour alone).
- While a nav row's chord collides with an app shortcut or a Monaco default, the row shall show a
  conflict note that names the other command.
- When the user resets a nav row, the app shall restore the default chord and remove the custom
  one.

E2E (new `test/e2e/nav-keybindings.e2e.mjs` on `harness.mjs`, reusing the `editor-nav-history`
TS fixture: `a.ts` calls into `b.ts`; real keyboard input; app hidden):

```gherkin
Feature: Configurable navigation shortcuts
  Background:
    Given the app is open on the two-file TS fixture with a.ts active and the caret on the call

  Scenario: AC-1 rows show the defaults
    When Settings → Shortcuts is opened
    Then a "Code navigation" group lists Go to Definition "F12", Go to Implementations
      "Ctrl + F12", Go to References "Shift + F12" (Windows run)

  Scenario: AC-2 rebind definition, live, no reload
    When Go to Definition is recorded as Alt+D and Settings is closed
    And Alt+D is pressed in a.ts
    Then the active doc is b.ts at the definition line
    And the page was not reloaded (a window marker set before the rebind survives)

  Scenario: AC-3 old chord is inert
    Given Go to Definition is Alt+D
    When the caret is back on the call in a.ts and F12 is pressed
    Then the active doc and caret are unchanged after 1 s

  Scenario: AC-4 references rebind opens references
    When Go to References is recorded as Alt+R and Alt+R is pressed on the symbol
    Then the references peek (or the single-result jump) appears exactly as Shift+F12 does today

  Scenario: AC-5 built-in surfaces follow the rebind
    Given Go to Definition is Alt+D
    When a TS plan code block is focused on an imported symbol and F12 is pressed
    Then nothing navigates
    When Alt+D is pressed
    Then the same outcome as today's F12 on that block occurs

  Scenario: AC-5b peek inside a code viewer follows the rebind
    Given Go to References is Alt+R and a references peek is open in a.ts
    When focus is in the peek's embedded editor on a symbol
    And Alt+R is pressed
    Then Monaco's references command runs there (the peek updates)
    When Shift+F12 is pressed there
    Then nothing happens

  Scenario: AC-5c Ctrl+F12 no longer reaches Definition once Definition is rebound
    Given Go to Definition is Alt+D and Implementations is at its default
    When Ctrl+F12 is pressed on an interface method in the code viewer and in a TS plan block
    Then Implementations runs on both surfaces, never Definition

  Scenario: AC-6 reset
    When Reset is clicked on Go to Definition
    Then F12 navigates again and Alt+D does nothing

  Scenario: AC-7 swap
    When Definition = Shift+F12 and References = F12
    Then Shift+F12 goes to the definition and F12 opens references

  Scenario: AC-8 refusal
    When Record is clicked on Go to Definition and "d" is pressed
    Then the row still shows recording with "This key types text in the editor"
    And Escape leaves the binding at F12

  Scenario: AC-9 persistence
    Given Go to Definition is Alt+D
    When the app is relaunched on the same user-data dir
    Then the row shows "Alt + D" and Alt+D navigates

  Scenario: AC-10 context-menu hint
    Given Go to Definition is Alt+D
    When the code editor is right-clicked on a symbol
    Then the "Go to Definition" row shows "Alt + D"
```

- AC-11: the existing `editor-nav-history` and `go-lsp` (where gopls is available) scenarios stay
  green at default bindings.
- AC-12: `npm run verify` is green.
- AC-5's first half (a default chord removed on a built-in surface) is the measurement that settles
  the removal-rule ASSUMED row in §0.
- The diff viewer is covered by U4 plus manual QA, because a diff model's navigation outcome is
  language/URI-dependent. The build states which e2e surface it used and why.

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Nav row | Default | Label, `<kbd>` combo, Record | Record |
| Nav row | Overridden | Custom combo, Record, Reset | Record / Reset |
| Nav row | Recording | Accent "Press keys…" chip | Keypress / Escape |
| Nav row | Recording + refused | "Press keys…" plus an inline reason line under the row | Another keypress / Escape |
| Nav row | Conflict | "· conflict: <other command>" (text, red token) | Informational |
| Nav row | Unbindable stored value | Stored combo plus "· can't be bound in the editor" | Record / Reset |
| Group | First-run, empty, loading, offline, permission | N/A: static list, settings already hydrated, local only | none |
| Context-menu nav rows | Always | Effective chord as the hint | existing |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Record button | Start recording | Click | Tab to focus, Enter/Space; next non-modifier key records; Escape cancels (overlay stack) | Tap (no keyboard means no record; acceptable) | none | `button`, accessible name "Record shortcut for Go to Definition" |
| Reset button | Clear override | Click | Enter/Space | Tap | none | `button`, name "Reset Go to Definition to F12" |
| Refusal line | none | none | none | none | none | Announced through a polite live region. `settings-modal.tsx` has none today, so the Shortcuts tab adds one (visually hidden `aria-live="polite"`) |
| Editor | Invoke nav | none (Ctrl+click unchanged) | Effective chord | none | Hint shows the chord | Monaco-owned |

Keyboard while recording: Tab is **recordable**, because a `Shift+Tab`/`Ctrl+Tab` chord is legal for
app rows. For nav rows, bare Tab is refused as a typing chord. Focus stays on the Record button
after recording ends.

## 10. Accessibility & i18n (UI)

- **Keyboard:** everything is operable by keyboard (above). Recording captures on window keydown,
  so focus stays on the button.
- **Visible focus:** reuse `.shortcuts__btn` focus-visible styling and verify it in forced-colors.
- **Names:** Record and Reset get row-specific `aria-label`s. Today they are just "Record" and
  "Reset" repeated per row, which is fixed for the new rows and harmless to apply to all rows.
- **Announcements (polite, through the new region in §9):** "Recording shortcut for Go to Definition. Press keys, Escape to
  cancel." on start; "Go to Definition set to Alt + D" on save; the refusal reason on refusal;
  "Go to Definition reset to F12" on reset.
- **Not colour-only:** conflict and refusal are text. The red or accent colour is secondary.
- **Reduced motion:** no animation involved.
- **i18n:** Conduit has no string-externalisation layer today; the strings follow the existing
  inline convention in `shortcuts.ts` and `settings-modal.tsx`, so no new i18n debt is added
  (see A3). Combo tokens are rendered via `formatCombo`, which is platform-aware but not
  locale-aware. Key names (F12, Alt) are not translated, as in VS Code. **Keyboard layouts:**
  editor rows use key-code capture (§3), so the label names the key Monaco fires on (§4). The layout must tolerate a
  longer conflict note: the note wraps under the label and is never truncated.
- **RTL:** not supported by the app; no change.

## 11. Design tokens (UI)

Reuse the existing `.shortcuts__*` classes:

- `--accent` for the recording chip;
- `--red` for the conflict note;
- `--text-muted`/secondary for the refusal line (existing muted-text token);
- `--font-scale` sizing.

Nothing new. Verify the rows in all three themes with `npm run shots` or a screenshot to the temp
dir.

## 12. Assumptions

- A1. The existing Shortcuts tab is the home for this feature. There will be no new settings
  section.
- A2. Conflict policy stays warn-not-block, consistent with the existing app rows.
- A3. User-facing strings follow the repo's inline-string convention. There is no i18n layer to
  externalise to.
- A4. Monaco's default keybinding list is read from its internal `KeybindingsRegistry` by deep
  import, the same pattern as `monaco-commands.ts`'s `StandaloneServices` import.
- A5. One chord per command, as in the existing data shape.
- A6. Nav chords are editor-only, with no app-dispatcher fallback, unlike `nextChange`. Without an
  editor cursor there is nothing to navigate from.
- A7. The Command-palette rows for these commands are not added here. There are none today.

## 13. Decisions Needed

- **[normal] N1 — Group placement.** Default taken: a new "Code navigation" group after "Editor".
  The alternative is appending the rows to "Editor".
- **[normal] N2 — Refusing typing and untranslatable chords for nav rows.** Default taken: refuse,
  with an inline reason. The alternative is to accept and warn. The reason for refusing is that a
  silently dead binding and a letter that stops typing both look like bugs.
- **[normal] N3 — Should diff, plan and peek surfaces run the Conduit nav path (`runNavCommand`)
  instead of Monaco's built-ins, as part of this feature?** Default taken: no. Only the chord is
  unified, and routing is a separate item. If yes, the scope grows into outcome messages and
  history on those surfaces.
- **[normal] N4 — Extend the scope to Peek Definition, Find All References and Go to Type
  Definition now?** Default taken: no. The user named three commands. The data shape makes adding
  the others an append.
- **[normal] N5 — Unbind (no chord) support.** Default taken: not in this item. The existing UI
  has no "remove" either.
- **[normal] N6 — Route through the dispatch command only when overridden, or always?** Default
  taken: only when overridden, so default behavior stays byte-identical. "Always" would be one path
  instead of two, but it changes the default path for every user.
- **[normal] N7 — Key-code (`e.keyCode`) capture for editor rows only.** Re-locked after code
  review: the first build captured `e.code`, which is not what Monaco resolves on (§3). App rows keep
  `e.key`, so their behavior does not change. Unifying the two is a separate item.
- **[high] H1 — Mechanism risk: removal and peek routing are source-read, not measured.** The spec
  relies on two things:
  1. `-editor.action.X` removal through `monaco.editor.addKeybindingRules` in 0.55.1. The resolver
     code supports it.
  2. The peek's embedded editor being identifiable as "not a code-viewer editor" at dispatch time.

  Default taken: build a spike first and prove both with AC-5, AC-5b and AC-5c before anything
  else. If either fails, stop the item and escalate rather than substituting a no-op-override or a
  context-key hack. Tagged high because it decides whether "the old chord stops working
  everywhere" is achievable cleanly.

## Self-audit

- Sections 1–13 are filled. The UI module is walked. Every current-behavior claim is either
  measured (the F12 e2e) or marked ASSUMED, with its risk carried as H1 or noted in §0 and covered
  by an AC.
- Producer and consumer are named for every changed flow, and none is one-sided.
- Line budget: about 520 lines, over the ~400 FULL cap. The overage is the mechanism detail the
  independent review found missing: the second `isWeb` default, peek routing, and physical-key
  capture. H1 depends on that detail.
- An independent reviewer pass (fresh agent, read-only) found 10 gaps, and all of them are folded
  in:
  - the `isWeb` Ctrl+F12 default;
  - the peek context-key inheritance;
  - macOS ⌥ capture and keyboard layouts;
  - code-viewer chord conflicts and provider fall-through;
  - the unmeasured live-region and unmount claims;
  - the mount-time registration;
  - recorder normalisation scope;
  - the mac hint;
  - AC testability;
  - peek and Ctrl+F12 ACs.
