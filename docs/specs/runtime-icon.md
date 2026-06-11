# Spec — Runtime icon on session tabs (wishlist D4)

**Tier:** LITE · **Type:** UI · **Slug:** `runtime-icon`

## Problem frame

**Job:** When scanning the sessions panel with several sessions open, the user wants
to tell at a glance *what kind of thing is running* in each one — "this one's Claude,
that one's a plain PowerShell, that one's Git Bash" — without reading the label.

**Actor:** Conduit user with multiple concurrent sessions.

**Success:** Each session tab leads with a small icon derived from the session's
agent/command. A Claude-style agent shows a distinct AI/sparkle glyph; a shell shows
a terminal/PowerShell glyph; anything unknown shows a generic terminal glyph.

**Non-goals:**
- Live PTY child-process detection (what the user typed *inside* a shell). Deferred —
  see Decisions Needed. The reliable signal is the session's launch spec.
- Official/branded logos. We use a tasteful, non-trademarked AI/sparkle mark for
  Claude-like agents; we do **not** claim it is the official Claude/Anthropic logo.
- Per-session user-chosen icons / icon customization.

## Behavior & states

A session always maps to exactly one icon kind (total function, never empty):

| Icon kind | When | Glyph |
|---|---|---|
| `claude` | agent is Claude-like (command/id/args mention `claude`) or other known AI agents (`aider`, `cursor`, `copilot`, `gemini`, `codex`, `goose`) | AI/sparkle mark |
| `powershell` | command basename is `powershell`/`powershell.exe` or `pwsh`/`pwsh.exe` | PowerShell glyph |
| `terminal` | command basename is a known shell: `bash`, `zsh`, `sh`, `fish`, `cmd`/`cmd.exe`, `wsl`/`wsl.exe`, `nu`, `csh`, `tcsh`, `dash`, `ksh` | terminal glyph |
| `terminal` | fallback — unknown agent/command | terminal glyph (generic) |

Resolution is **deterministic, case-insensitive, basename-aware** (strips full paths
and `.exe`), and considers the agent's `command`, `id`, and `args` (e.g. an agent
that launches `npx claude` or a shell that runs `-c "claude"`). First match wins in
priority order: Claude/AI agents → PowerShell → other shells → generic fallback.

The icon is **static metadata** — it does not change while the session runs (matches
the deferred-live-detection decision). It re-derives only if the session's agent
changes (it doesn't, today).

## Data / interface contract

Pure mapper in `src/` (testable, importable by webview):

```ts
export type SessionIconKind = 'claude' | 'powershell' | 'terminal';
// Resolve from an agent definition (preferred — carries command + args + id):
export function iconForAgent(def: AgentDefinition | undefined): SessionIconKind;
// Convenience for the webview given a session + the agents list:
export function iconForSession(
  session: Pick<Session, 'agentId'>,
  agents: AgentDefinition[],
): SessionIconKind;
```

- Inputs: an `AgentDefinition` (or a session + agents list). Robust to `undefined`
  agent (returns `'terminal'`).
- Output: one of three `SessionIconKind` values. Total — never throws, never empty.
- Invariant: same input → same output; no I/O, no clock, no globals.

The webview maps `SessionIconKind` → an icon component from `webview/icons.tsx`.

## Edge cases & failure modes

- **Unknown agent id** (session references an agent not in the list) → `'terminal'`.
- **Empty/whitespace command** → fall through to id/args, else `'terminal'`.
- **Full path command** (`C:\Program Files\Git\bin\bash.exe`) → basename `bash` →
  `terminal`.
- **`.exe` / `.cmd` suffix** → stripped before matching.
- **Args carry the real program** (e.g. agent `command: "cmd"`, `args: ["/c","claude"]`)
  → Claude wins (AI agents take priority and are matched across command+id+args).
- **Mixed case / odd casing** (`PowerShell.EXE`) → matched case-insensitively.
- **`window.agentDeck` undefined (browser preview)** → unaffected; mapper is pure and
  the icon renders from mock agents.

## Defaults vs settings

- Showing the icon is **on by default**, no setting. Rationale: it's compact, purely
  additive, and the whole point of the feature; a toggle would be over-production for
  a LITE item. (If later noisy, a `showSessionIcon` setting can be added — out of
  scope now.)

## Scope slicing

- **MVP (this):** pure mapper + 3 glyphs (claude / powershell / terminal) + render the
  icon leading the session name in the sidebar card. Unit-tested mapper.
- **v1 (future):** more agent brands; a PowerShell-specific vs generic-terminal visual
  split already included.
- **Vision (deferred):** live foreground-process detection in the PTY to reflect what
  the user launched *inside* a shell (e.g. they typed `claude` in bash). Requires
  reliable cross-platform process-tree inspection — fragile on Windows — so deferred.

**Out of scope:** live detection, per-session custom icons, a visibility setting, busy
/attention state on the tab (that's D5).

## Acceptance criteria

- AC1: `iconForAgent` returns `'claude'` for an agent whose command/id/args contain
  `claude` (any case, with/without path/`.exe`), and for known AI agents (aider,
  cursor, copilot, gemini, codex, goose).
- AC2: returns `'powershell'` for `powershell`/`powershell.exe`/`pwsh`/`pwsh.exe`
  (any case, full path).
- AC3: returns `'terminal'` for `bash`, `zsh`, `sh`, `fish`, `cmd`, `wsl`, `nu`,
  `csh`, `tcsh`, `dash`, `ksh` (basename, any case).
- AC4: returns `'terminal'` for an unknown command and for `undefined`.
- AC5: AI-agent match takes priority when both an AI keyword and a shell appear
  (command `cmd`, args `["/c","claude"]` → `'claude'`).
- AC6: `iconForSession` resolves the session's agent from the list and falls back to
  `'terminal'` when the agent id is not found.
- AC7: In the running app/preview, each session card renders the icon leading the
  name; a Claude-ish session shows the AI glyph and a shell session shows the terminal
  /PowerShell glyph. The existing name / metadata / sort layout (D1–D3) is unbroken.
- AC8 (a11y): the icon is decorative — it has `aria-hidden` (or the card exposes the
  agent label as accessible text), so screen readers aren't given a redundant/empty
  graphic. The icon uses `currentColor` and the existing 16px grid (consistent with
  the icon set), and is not the sole carrier of meaning (the agent label/name remains).

## UI module (checklist)

- **States:** one icon per session; no hover/focus/disabled variants (decorative,
  non-interactive). Icon color follows text color via `currentColor`.
- **Interaction:** none — the icon is non-interactive; clicks pass through to the card
  (it sits inside the existing clickable card; `pointer-events` need not be special-cased
  but the icon must not intercept the card's select/contextmenu).
- **Accessibility:** decorative `aria-hidden`; meaning is also carried by the visible
  name + (optionally) the agent label, so the icon is never the only signal. Honors
  high-contrast via `currentColor`.
- **i18n:** no text in the icon; nothing to translate. The agent label (already shown
  elsewhere) is the textual equivalent.
- **Design tokens:** reuse the existing `webview/icons.tsx` 16px/`currentColor`
  pattern and the sidebar's existing class conventions; no new colors/hex.

## Self-audit

All core-spine sections and the UI checklist are addressed. No template items left
unfilled for a LITE/UI feature.

## Decisions Needed

- **[normal] Live detection deferred.** We map the session's *launch spec*, not the
  live foreground process. If the user starts a shell and then runs `claude` inside
  it, the tab keeps the terminal icon. Chosen because reliable foreground-process
  detection (esp. on Windows PTYs) is fragile and risky; the launch-spec signal is
  deterministic and testable. Safe/reversible: live detection can layer on later
  without changing the mapper's contract.
- **[normal] Claude glyph is a generic AI/sparkle mark**, not an official logo, to
  avoid trademark issues. Reversible.
- **[normal] PowerShell uses a distinct glyph from the generic terminal** (nice-to-
  have, included since it's cheap). If a dedicated PowerShell glyph proves not worth
  it, falling back to the terminal glyph is trivial.
