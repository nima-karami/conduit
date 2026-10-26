# Placeholder fix — handoff (2026-10-26)

Branch `selfhost/placeholder` (from `feat/conduit-mcp` d04e2041). Not pushed.

| Commit | What |
|---|---|
| `d4023fe6` | The fix: dim-styled placeholder / suggestion cells don't count as input (review: APPROVE) |
| `c3e9bb33` | Review follow-ups 1–4 and nits, below |

## Review follow-ups

| Item | State | Where |
|---|---|---|
| 1 Narrow the strip: one dim run from the cursor to end of row, right after a bare prompt; `cursorX` in the snapshot, cursor must sit at the run's start | **done** | `src/conduit-mcp/screen-verdict.ts` `inputRow` |
| 1 Measure paste chip, image chip, Ctrl+R; record them | **done**, with gaps: Claude image chip not produced by the headless driver (pasted path ignored); Codex showed no paste chip at ~2.4k chars (inline) | `placeholder-cells.md` "Drafts that must never read as empty" |
| 1 A draft with a chip is never empty-input (incl. a chip drawn faint) | **done** | `test/unit/conduit-mcp-adapters.test.ts` "a draft holding a … is never empty-input" |
| 2 Styles required in production snapshots; `placeholderText` dropped | **done**. All fixtures carry `cursorX` + `cursorRowStyles` (S0 masks set from the measurement) | `ScreenSnapshot` in `screen-verdict.ts`; `adapters.ts`; `test/unit/fixtures/conduit-mcp/screens/*.json` |
| 3 Styles only for the rows the verdict reads; text via translateToString | **done**. Only the cursor row: under the narrowed rule nothing else is stripped (echo reads raw rows) | `electron/session-screens.ts` `styleMask` |
| 4 Test with the real first-paint `Try "…"` mask (dim words, plain gaps) | **done** | fixture `claude-idle-placeholder.json`; test "Claude's first-paint Try placeholder…" |
| Nit: ScreenPatterns doc comment | **done** | `src/conduit-mcp/adapters.ts` |
| Nit: readRow bounds / break on undefined cell | **done** (`styleMask` loops to `line.length`, breaks when `getCell` returns undefined) | `electron/session-screens.ts` |

## Gates on c3e9bb33
- Unit (`conduit-mcp-adapters`, `session-screens`, `conduit-mcp-host`): exit 0, 97 pass.
- `npm run verify:quick`: exit 0 (1779 pass / 3 skip).
- Local e2e not run for the follow-ups (conductor runs e2e remotely).

## Left
- Remote e2e confirmation of `conduit-mcp-gate` (local runs timed out under load after cases a–c passed; see the d4023fe6 report).
- Claude image-chip style is unmeasured; the cursor rule covers it either way.
