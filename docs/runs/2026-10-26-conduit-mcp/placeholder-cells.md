# Placeholder cells — how the CLIs style input-row placeholders (2026-10-26)

Why: Claude Code 2.1.310 puts a **suggested next prompt** in its input row after a turn
(`❯ keep going, ping me when C2 is merged`). The claude adapter's empty-input patterns didn't match it, so
the notice gate sat at `no-empty-input` and notices were never delivered.

Driver: `@lydell/node-pty` → `@xterm/headless` at 120×36, cwd = the Conduit repo, `CLAUDE*` env vars
stripped. Each input-row cell read via `buffer.active.getLine(y).getCell(x)`: `isDim()`, `isBold()`,
`getFgColorMode()`/`getFgColor()`. Fixtures (with `cursorX` and a `cursorRowStyles` mask, `d` = dim, `.` = otherwise):
`test/unit/fixtures/conduit-mcp/screens/{claude-suggestion,claude-typed,codex-placeholder,codex-typed}.json`.

| | CLI | Row text | Cell style |
|---|---|---|---|
| a | claude 2.1.310 | `❯ Try "refactor <filepath>"` (fresh, empty input) | `❯ ` default; placeholder **dim (SGR 2), fg default** |
| b | claude 2.1.310 | `❯ yes, go ahead` / `❯ go ahead` / `❯ write the script` (after a turn) | `❯ ` default; suggestion **dim, fg default**; cursor parked at x=2, before it |
| c | claude 2.1.310 | `❯ hello there`, `❯ yes go` (typed) | all cells default: **not dim**, fg default |
| d | codex 0.164.0 | `› Ask Codex to do anything` | `›` bold; placeholder **dim, fg default** |
| e | codex 0.164.0 | `› Summarize recent commits` (typed — the words of one of its own placeholders) | `›` bold; text **not dim**, fg default |

Findings:
- **Dim is the discriminator for both CLIs.** No grey/palette colour is involved: placeholder and typed
  text both use the default foreground. So the adapters declare `placeholder: 'dim'`; no colour predicate.
- Claude's first paint of `Try "…"` leaves the gaps between words as non-dim cells (cursor-forward moves);
  a repaint after Esc-clear fills them dim. Whitespace is irrelevant to the prompt match either way.
- Typed text over a suggestion replaces it (`❯ x`, normal), and backspacing to empty brings back a bare `❯`.
- While a turn runs, Claude paints `❯` grey (`rgb #999999`), not dim — unaffected by the strip.
- **When the suggestion appears** (from the 2.1.310 binary, confirmed by runs): only from the 2nd assistant
  turn on (`early_conversation`), not on cache-cold turns, not in plan mode or under rate-limit warnings, and
  with a back-off after a streak of unused suggestions. One-turn probes never show it; a 3-turn probe does.

## Drafts that must never read as empty (measured for the narrowed rule)

| CLI | Draft | Style | Cursor |
|---|---|---|---|
| claude | bracketed paste of 30 lines → `❯ [Pasted text #1 +29 lines]` | **plain** (not dim), default fg | after the chip (x=28) |
| claude | pasted image path | not turned into a chip by the headless driver (no `[Image #N]` seen); not measured | — |
| claude | Ctrl+R → `search prompts:` on its own row | grey `rgb #999999` / amber, not dim | on that row, which has no `❯` |
| codex | bracketed paste, 30–60 lines (~2.4k chars) | shown inline, **plain**; no chip appeared | after the text |
| codex | pasted image path → `[Image #1]` | **palette colour 6**, not dim | after the chip (x=13) |
| codex | Ctrl+R → `reverse-i-search:` | **dim**, but on a row without `›` | on that row |

So the strip is narrowed to the measured shape: **one dim run from the cursor to the end of the row,
directly after a bare prompt** (whitespace gaps inside the run may be plain — Claude's first paint).
A placeholder or suggestion parks the cursor at the run's start (x=2 for both CLIs); every draft above
leaves it after the text, so even a chip drawn faint can't read as empty-input. Only the cursor row
carries styles. The S0 fixtures got `cursorX` and a cursor-row mask from these measurements
(`claude-idle-placeholder` uses the first-paint shape; `codex-idle` the codex placeholder shape).

## Turning suggestions off per launch

`--settings '{"promptSuggestionEnabled":false}'` works (setting name from the 2.1.310 settings schema:
"When false, prompt suggestions are disabled"). Measured: a 3-turn run with the flag showed no suggestion
and no `Try "…"` placeholder either; the same script without it showed `❯ go ahead` (dim) after turn 3.
The env var `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` takes precedence over the setting per the binary;
`1` measured to force suggestions on (past the server-side flag), `0` not measured. The gate fix doesn't rely on either.
