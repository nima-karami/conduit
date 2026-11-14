# UI: Conduit

How Conduit looks. No flows or screen orders: those are in [UX.md](UX.md). Values are taken from
the code (`webview/styles.css` unless noted); anything not in the code yet is marked `[proposed]`.
The token contract's earlier source is `docs/design-handoff/revamp/spec/`.

## 1. Character

A calm, dark working surface where the agent terminals are the content and the chrome steps back.
State speaks through small, precise marks and a few words. It must never feel noisy, never be a
dashboard of competing colours, and never hide what needs you. Reference points: VS Code for
structure, iOS and Apple for calm and clarity, Notion for readable text `[owner, 2026-11-14]`.

## 2. Tokens

**Rule:** a theme owns colour, shape and material; density owns spacing and size
`[evidence: styles.css:1-4; enforced by test/unit/theme-tokens.test.ts:163]`.

**Themes:** Aero Dark (default), Aero (light) and Neon `[evidence: webview/themes.ts:20-45]`. A theme
also picks fonts, the code surface and the icon pack unless the user pinned them. Conduit doesn't
follow the OS light/dark setting today (no `prefers-color-scheme`); see the open question in UX.md.

| Colour role | Aero Dark (`:root`) | Aero (light) | Token |
|---|---|---|---|
| surface (window ground) | #131419 | #eceff4 | `--bg` (plus `--ground`, two radial gradients) |
| panel | #1b1d24 | rgba(255,255,255,.74) | `--panel` |
| raised | #23252e | #ffffff | `--raise` |
| text | #e7e9f0 | #1b1f2a | `--text` |
| muted | #9aa0b2 | #5c6274 | `--text-dim` |
| faint | #6d7385 | #666d7b | `--text-faint` |
| line | rgba(255,255,255,.085) / .12 | rgba(27,31,42,.08) / .12 | `--border` / `--border-2` |
| accent (selection and "on" only) | #8b95f0 | #4a56c8 | `--accent`, `--accent-soft` |
| accent ink | #12131a | #ffffff | `--on-accent` |
| success | #6cc18a | #2f8f5b | `--green` / `--success` |
| attention ("needs you") | #e5a94a | #d6922a | `--amber` |
| danger | #e0726f | #c4483f | `--red` / `--danger` |
| info | #7fa8e8 | #3a6ecc | `--blue` |
| code surface (dark in every theme) | #15161b | #1b1e2b | `--code-base` |
| scrim | rgba(9,10,14,.34) | — | `--scrim` |
| focus | layered ring | layered ring | `--focus-ring`; `Highlight` under forced colours |

Neon: near-black violet ground (#07060d), cyan accent (#00f0ff), magenta attention (#ff2d9b), glows
in place of shadows, scanlines, all radii 0 and a chamfered corner `[evidence: styles.css:409-600]`.

Other token families: interaction states `--state-*` (hover is a neutral wash; accent means
selected or on `[evidence: docs/specs/archive/2026-08-01-interaction-state-vocabulary.md]`), diff
and change, syntax `--syn-*`, agent identity marks `--mark-*`, timer.

| Type role | Family + fallback | Weight | Size | Line height | Token |
|---|---|---|---|---|---|
| UI text | Figtree (Aero), Chakra Petch (Neon); pickable: Hanken Grotesk, Inter, IBM Plex Sans, System UI | 400 / 500 buttons / 600 emphasis | 13 Comfortable, 11.5 Compact, × font scale 0.9 / 1 / 1.12 / 1.25 | — | `--density-font`, `--font-scale` |
| Mono and terminal | IBM Plex Mono (Aero), JetBrains Mono (Neon); pickable: Fira Code; fallback Cascadia Mono | 400 | follows the UI scale | — | theme font setting |
| Band label | UI family | 700 | 12 / 11 | — | `--label-case`, `--label-track`, `--label-weight` |
| Named type scale | — | — | **none today**; sizes are literals (11, 12, 11.5, 10.5, 12.5, 10, 13) × font scale | — | `[proposed]` a 5-step scale: 10.5 · 11.5 · 13 · 15 · 18, each × `--font-scale` |

**Spacing and density:** there's no generic spacing scale. Per-component density tokens
(`--density-*`) cover Comfortable and Compact `[evidence: styles.css:1081-1189]`:
- band 38 / 31
- top bar 1.5× the band
- agent row 30 / 26, child row 26
- button padding 6×14 / 4×11
- window padding 12 (Aero) or 0 (Neon), gutter 11
- sidebar 264, side panel 340

`[proposed]` a spacing scale of 4 · 8 · 12 · 16 · 24 · 32 for new components.

**Radius:** window 12 · panel 20 · card 15 · control 13 · badge 9 · md 8 · space tile 5 · round
999; Neon 0 `[evidence: styles.css:97-114]`.

**Elevation:** `--elev-1/2/3` (Aero Dark: 0 1px 3px .45 / 0 2px 14px .5 / 0 6px 20px .55); Aero is
lighter, Neon has none. Layers: modal 60, toast 80, popover 200, theatre 300.

**Motion:** short transitions, mostly 0.12 s ease; the modal pops in 0.14 s. Reduced motion is
honoured two ways: the OS setting and the in-app Reduce motion setting (`data-reduce-motion`). The
animated background pauses when the window is unfocused, hidden or idle for 60 s
`[evidence: webview/motion-pause.ts]`.

## 3. Components

Existing components are in `webview/components/` and `styles.css`. New ones from the approved
CON-10 design are marked `[proposed]`.

| Component | Role | Anatomy · variants | States | Do / don't |
|---|---|---|---|---|
| Button `.btn` | An action | Label; primary, ghost, small, danger, warn | rest, hover (neutral wash), focus ring, pressed, disabled | One primary per surface. Don't colour a button to show state |
| Icon button `.iconbtn` | A compact action in a band | 16-grid icon + tooltip | as button; `aria-pressed` for toggles | Always has a tooltip and an accessible name |
| Segmented control `.seg` | Choose one of 2–4 | Segments | selected uses accent | Not for more than 4 options |
| Select `.selectfield`, popover, context menu `.ctxmenu` | Choose from a list; actions on a thing | Items, checks, separators, submenus | active, checked, disabled | Every context-menu action also has a visible path (UX rule) |
| Modal `.modal` + confirm | One focused task | Title, body, actions | — | Confirm only what can't be undone |
| Toast `.toast` | A brief result | Message + one action (Undo, Renew) | info, error | Silence means success; no "Saved!" toasts |
| Tabs `.tab` | Switch documents | Icon, name, close | active, dirty, overflow | The terminal tab is always first |
| Agent row and state mark `AgentMark` | One agent in the sidebar | Glyph, name, age, state mark, hover actions | Needs you, Working, Done, Idle, Stopped, selected | State shown by mark shape and words, not colour alone |
| Chip (branch, timer, scope) | A small status you can act on | Icon + short text | rest, hover | — |
| Empty state `EmptyState` | Say why it's empty and the next step | Line + one action | inline, pane, panel | One action, not a menu |
| Banner (server, agent scope, MCP setup, proposal) | Trouble or a suggestion in place | Message + fix buttons | — | Says the fix, with a button |
| Request card `[proposed]` | One request in Needs you | Type icon (Approve check, Answer bubble "?", Review page), Conduit chip when Conduit wrote it, session + agent, one-line ask, why now (countdown, urgent, machine, size) | rest, selected, waiting | Two lines; no kind tags; never answered in place `[evidence: CON-10 iter-7]` |
| Request pop-up / tab `[proposed]` | Answer one request | Header · Context · Answer (options, own words, Send) · Footer (this request · the queue) | open, sending, ended (withdrawn, answered elsewhere) | Permission options start unselected; Send is plain "Send" |
| Session pill `[proposed]` | A blocked agent's state in its terminal header | Icon + "Waiting on you · 0:46 · 1 request" | — | One per session; links to its request |

## 4. Icons and imagery

- **Chrome icons:** the custom set in `webview/icons.tsx`: 16-grid, currentColor stroke; Neon swaps
  in angular variants. Lucide covers a few glyphs and the session icon picker.
- **Agent marks:** `--mark-*` per CLI (`src/agent-icon.ts`). File-type icons: none, minimal or coloured.
- **Backgrounds:** None, Aurora, Mesh, Grid, Flow or Shader, with intensity, surface opacity and blur.
  Decorative only: never carries meaning.
- `[proposed]` The three request-type icons have distinct silhouettes, so they read without colour.

## 5. Accessibility floor

- Text contrast 4.5:1, 3:1 for large text and controls. Exceptions signed off in the revamp
  (3.58, 2.62, 4.11) are listed in `docs/design-handoff/revamp/spec/00-README.md`. Check new work
  with `test/unit/theme-tokens.test.ts`.
- **Focus:** one visible `--focus-ring` on every interactive role; an inset ring on clipped surfaces.
- **Forced colours:** supported (19 blocks). `prefers-contrast`: not handled today.
- **Targets:** at least 24×24; frequent pointer targets (agent rows, request cards, Send) bigger,
  because the pointer is a main interface `[owner, 2026-11-14]`.
- Colour is never the only signal: state marks differ in shape and carry words.
- **Known gaps** `[evidence: inventory 2026-11-14]`:
  - The command palette has no dialog or listbox roles.
  - The Settings modal has no dialog role, and its nav isn't tabs.
  - There's no skip link.

## 6. Do's and don'ts

- **Do** keep the accent for selection and "on". Hover is a neutral wash.
- **Do** keep code and terminal surfaces dark in every theme.
- **Do** use attention (amber; magenta in Neon) only for "needs you".
- **Don't** add a colour without a role in all three themes.
- **Don't** put spacing in a theme block, or colour in a density block.
- **Don't** add `!important`, specificity escalation or magic offsets (CLAUDE.md).
- **Don't** let decoration (background, glow) sit behind text that must be read.

## 7. Decisions

| Date | Decision | By | Why |
|---|---|---|---|
| 2026-07-31 | Three themes (Aero, Aero Dark, Neon); a theme owns colour, shape and material, density owns size | owner | The revamp handoff `[evidence: docs/design-handoff/revamp/]` |
| 2026-08-01 | Hover is neutral; accent means state | owner | `[evidence: docs/specs/archive/2026-08-01-interaction-state-vocabulary.md]` |
| 2026-11-14 | Request card, pop-up/tab template and session pill from CON-10 iter-7 | owner | Approved design |
| `[proposed]` | A named type scale and a spacing scale for new components | — | Today's literal sizes drift |
