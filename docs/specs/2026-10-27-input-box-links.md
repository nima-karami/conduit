---
status: draft
date: 2026-10-27
tier: LITE
---

# Feature Spec: No links in an agent CLI's input box

**Tier:** LITE   **Feature type:** UI (one surface: the terminal link provider)
**Request (verbatim intent):** "the URLs, the file names, and all of that in the placeholder text in the
chat box of Claude. Those shouldn't be clickable, not even in something I type. Only the texts that the
agent gives the user need to be clickable."

## 1. Problem frame
- **Job:** hovering or clicking in the box I am typing into — or on a prompt I already sent — never
  turns my own text, a pasted URL or the CLI's suggested prompt into a link; what the agent printed
  stays one click away.
- **Success:** in a live input box no URL, path or commit link is offered (pointer, underline, click,
  right-click menu, keyboard "open links"); agent output above the box links exactly as today.
- **Non-goals:** OSC 8 hyperlinks (xterm's own provider; agents emit them only in output); plain shell
  prompts; a setting.

## 2. Behavior & current state
**Rule.** While an agent CLI's input box is live, every buffer row from the box's first row to the end of
the buffer is excluded from link detection. "Live" is decided from the active buffer and the cursor on
every `provideLinks` call, so the box stops excluding the moment the cursor leaves it.

| Shape | Applies to | Box found when | First excluded row |
|---|---|---|---|
| **ruled** | every terminal (no identity needed) | the nearest rule row at or above the cursor, the nearest at or below it, both within `rows` (viewport height) of the cursor row, and the row under the top rule starts with Claude's prompt glyph (`❯`, or `!` in bash mode) | the top rule |
| **prompt** | sessions whose agent has an MCP adapter that locates its input row (Codex `›` via new `inputBox`; Cursor `→` via its existing `inputRow`) | the pattern on the cursor row or up to `maxAbove` (8, as `screenVerdict`) rows above, and no adapter `blocking` pattern on screen | that prompt row |

**Echoed prompts (D1, ruled by the conductor 2026-10-27).** A prompt the user submitted, echoed into
history by the CLI, is the user's text and never links. It is told apart by cell style, never by glyph
alone, so agent output that starts with `>` or `❯` still links:

| CLI | Applies to | An echo is | Measured |
|---|---|---|---|
| Claude | every terminal | a `❯` row whose column-0 cell has a non-default background, plus the rows directly below with the same column-0 background (wrapped/multi-line prompt) | real `claude --model haiku` (v2.1.312) capture: echo rows 5–7 on RGB #373737 full width; live box `❯` row and output default background; markdown quotes render as `▎` → `fixtures/input-box-links/claude-echo-draft.json` |
| Codex | codex adapter (`promptEcho`) | a `›` row at column 0 whose first cell is dim, plus the indented non-blank rows below it, up to a blank row | v0.164.0 capture: echo `›` dim, live composer `›` plain, agent rows start `•` (also dim) → `codex-echo-draft.json` |
| Cursor | — | not implemented | v2026.10.22 capture: echo rows have no glyph, only a background from column 1, and code-block styling is unmeasured — no reliable signal; echoes stay linked |

Rows below the box (Claude's status line and mode hint, `@`/`/` completion menus, Codex/Cursor footers)
are CLI chrome, not agent output, so they are excluded with it. A rule row is one that starts with `─`
and whose `─` cells fill at least half the terminal's width (Claude may embed a label in it). The `❯`
check is what keeps full-screen TUIs (lazygit, htop, fzf borders) out: their `─` rows never sit over
a `❯` row. A dialog that replaces the box (Claude permission, Cursor `→ Run (once)` approval) is not
excluded: Claude's has no rule pair around the cursor, Cursor's matches a `blocking` pattern.

| Claim about today | How measured | |
|---|---|---|
| Typed URL in Claude's box, its 2nd input row and the status row under the box all return a URL link | new e2e `terminal-input-box-links` run on the built app before the fix: provider returned `typed-input-link`, `second-input-row`, `placeholder-link` (log `%TEMP%\claude-scratch\input-links\e2e-before.log`, exit 1) | Measured |
| Claude 2.1.310 draws its box as full-width `─` rules around `❯` rows; the cursor sits inside; placeholder is a dim run on the `❯` row | captured real screens `claude-idle-placeholder.json`, `claude-typed.json`, `claude-suggestion.json` (120 `─` of 120 cols) | Measured |
| Codex: `›` prompt row, cursor on it, no rules; Cursor: `→` row with the cursor parked 5 rows below (`cursor-idle-after-turn`, `cursor-mid-turn`); a `→` 10 rows up is stale (`cursor-idle-stale-input-row-far-above` → `unknown` in screenVerdict) | captured `codex-*.json`, `cursor-*.json`; `conduit-mcp-adapters.test.ts` | Measured |
| The provider reads cell text only (no SGR), so a dim placeholder links like typed text | red unit test on the placeholder fixture before the fix (stage 2) | Measured in build |
| An echoed prompt's URL links today | e2e with the echo check removed from the pane: `echoed prompt must not link: {"links":["https://example.com/echoed-prompt-link"]}` (`e2e-mut2.log`, exit 1) | Measured |

## 3. Interface contract
- New pure module `src/input-box-rows.ts`: `inputBoxTop(rowAt, cursorRow, opts) → number | null` —
  `rowAt(y)` is a buffer row's text, `cursorRow` is absolute (`baseY + cursorY`), `opts` = `{ cols,
  rows, prompt?: { pattern, maxAbove, blocking } }`. `null` ⇒ no live box ⇒ nothing excluded.
- `ScreenPatterns.inputBox?: { pattern; maxAbove }` on codex only — its cursor sits on its row, so it
  needs no `inputRow` (adding one would change codex's `screenVerdict` echo window). The link side
  reads `inputBox ?? inputRow`; Claude needs neither — the ruled shape is generic.
- `TerminalPane` gets `inputBox` (resolved in `center-pane` from `agents` + `s.agentId` via
  `adapterFor`) through a ref; `provideLinks` and the keyboard path skip rows `>= inputBoxTop` and rows
  where `inPromptEcho(rowAt, y, echo?)` holds — `rowAt(y)` is `{ text, bg0, dim0 }` (column 0's
  background key, '' when default, and dim flag); `echo` is `ScreenPatterns.promptEcho` (codex only).
- Producer: the CLI's screen (PTY → xterm buffer). Consumers: the regex link provider and the keyboard
  link list; the hover/right-click menu reads what the provider returned, so it follows.

## 4. Edge cases
| Condition | Behavior |
|---|---|
| Multi-line / soft-wrapped input | all rows between the rules (or below the prompt row) excluded |
| Box present, cursor elsewhere (Claude permission dialog, cursor not between two rules) | no exclusion — dialog text is agent-proposed content |
| Scrolled back | exclusion is by buffer row, so history above the box links; the box rows stay unlinked |
| Alternate screen | same rule on the active buffer; TUIs kept out by the `❯` check |
| Draft taller than the viewport (top rule beyond `rows` above the cursor) | no exclusion (fails open); a long paste is a one-row chip in Claude |
| CLI with no adapter / unknown agent / plain shell | only the ruled shape |
| `codex`/`agent` started by hand in a plain shell | not covered (no identity) — false negative, today's behaviour |
| Agent prints a `─` rule in output | only the nearest rule above a cursor that also has one below counts — that is the box |
| `claude` started by hand in a plain shell | covered by the ruled shape |
| Prompt glyph not found within `maxAbove` (very long Codex/Cursor draft, stale Cursor row) | no exclusion (fails open to today) |
| Box submitted; CLI echoes the prompt into history | Claude/Codex: not linked (D1); Cursor: linked |
| Agent output starting with `>` (or a code block on a background) | linked: no echo glyph+style above it |
| Claude echo longer than 500 rows | rows past the walk limit stay linked (fails open) |
| Claude in a light theme or 256-colour mode | any non-default background counts, whatever its colour or mode |

## 5. Defaults vs settings
| Decision | Default | Configurable | Rationale |
|---|---|---|---|
| Exclude the live box | on | no | the request is absolute; nothing to tune |

## 6. Scope
- **MVP:** ruled shape (Claude) in every terminal; Codex/Cursor prompt shapes by adapter; keyboard path;
  echoed prompts for Claude (every terminal) and Codex (adapter).
- **Out:** Cursor echoes (no reliable signal); OSC 8; shell prompts.

## 7. Acceptance criteria
1. A URL typed in Claude's box, on any of its input rows, is not linked; a URL in output above is.
2. A URL in the dim placeholder is not linked.
3. Rows under the box (status line) are not linked.
4. Once the cursor leaves the box, the next `provideLinks` for its old rows (xterm asks again on the
   next pointer move onto a row) returns their links.
5a. The keyboard "open links" list (`pathLinksAtRef`) offers no path from box rows.
5. Codex `›` and Cursor `→` input rows (fixtures) are excluded only for those agents; a plain shell row
   starting with `›`/`→` is not.
5b. A URL in an echoed Claude prompt (both rows) is not linked; agent output `> see <url>` is.
6. `terminal-path-links`, `terminal-path-links-v2`, `terminal-links`, `terminal-link-menu`,
   `terminal-osc8-link` stay green.

**A11y / i18n:** no new UI or strings; fewer false link affordances for keyboard and screen-reader users.

## Decisions Needed
- **D1 — ruled (conductor, 2026-10-27):** echoed prompts are the user's text and do not link (§2).
  Cursor's are left linked: no reliable signal was measured.
- **D2 (normal):** chrome below the box (status line, completion menus) is excluded with the box.
