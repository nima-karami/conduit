---
status: active
date: 2026-06-17
---

# Agent-agnostic chat UI over CLI agents

## Problem

Today Conduit only runs agents as **raw terminals**. Launching Claude Code or Codex
spawns the CLI in a `node-pty` (`src/pty-host.ts`) and the renderer shows the literal TUI.
That throws away everything the CLIs already emit as **structured data** — assistant
messages, tool calls, tool results, permission requests, plan updates, token usage — and
forces the user to read a cramped, monochrome terminal reflow instead of a real chat. There
is no way to render an edit as a diff, click a file the agent touched, approve a single tool
call, or switch autonomy modes without typing CLI incantations.

Both CLIs already expose a programmatic, event-stream interface (verified June 2026):

- **Claude Code** — `claude -p --output-format stream-json --input-format stream-json`
  gives a **bidirectional NDJSON** session; the Agent SDK (`@anthropic-ai/claude-agent-sdk`)
  wraps the same CLI with typed messages, a `canUseTool` approval callback, mid-session
  `setPermissionMode`, and `--resume`. The first event is `system/init` (model, tools, MCP
  servers, plugins/skills).
- **Codex** — `codex exec --json` emits JSONL (`thread.*`, `turn.*`, `item.*` incl. agent
  messages, reasoning, command executions, file changes, MCP tool calls, **plan updates**);
  there is also `codex app-server` (JSON-RPC) and a Codex SDK.

The reference project [`clui-cc`](https://github.com/lcoutodemos/clui-cc) (Electron + React +
Zustand) validates the architecture end-to-end: one `claude -p --output-format stream-json`
subprocess per tab, an NDJSON event normalizer, and a localhost permission-hook server for
human-in-the-loop tool approvals.

## Goal

A **chat surface** that drives a CLI agent under the hood and renders a clean, elegant,
structured conversation — assistant markdown, collapsible thinking, rich tool-call cards,
inline tool approvals, a running-mode selector (including **Auto** mode), and a skills /
slash-command picker. The design is **agent-agnostic**: a normalized event model behind a
small `ChatAdapter` interface, so Claude Code and Codex are interchangeable.

**This spec builds the Claude Code adapter end-to-end** and **defines the abstraction** so a
**Codex adapter is a later drop-in**. It also designs (but does not build) the seam for
**interactive planning** — the agent presenting collapsible options/buttons the user picks.

## Scope at a glance

| Layer | v1 (build) | Designed only |
|------|------------|---------------|
| Adapter | `ClaudeCodeAdapter`, `FakeAdapter` (tests) | `CodexAdapter` |
| Modes | Plan · Default · Accept-edits · **Auto** | Bypass (opt-in, gated) |
| Tool UX | Rich cards + inline approvals (`canUseTool`) | — |
| Skills | Surface + invoke existing skills/slash commands | Skills marketplace/install |
| Planning | `plan_update` rendered **read-only** | Interactive option buttons |
| Persistence | Transcript + CLI session id, resume on reopen | — |

## Architecture

### 1. Session kind via protocol declaration

`AgentDefinition` (`src/types.ts`) gains an optional field:

```ts
protocol?: 'terminal' | 'claude-code' | 'codex'; // default 'terminal'
```

The launch decision (`resolveLaunchSpec` neighbourhood in `src/pty-host.ts`, and wherever the
host starts a session) branches on protocol:

- `'terminal'` (default, back-compat) or `'shell'` → today's `PtyHost` / `TerminalPane`.
- a chat protocol → new `ChatHost` / `ChatPane`.

The renderer picks the pane component by the session's resolved protocol. There are **no
hard-coded "if Claude Code" branches** outside the adapter registry — adding an agent is a
data change in `agents.json` plus (for a new protocol) one adapter.

Per the user's chosen session model: **any streaming-capable AI agent opens as chat**; only
`shell` and protocol-less CLIs stay terminals. A chat session **never touches node-pty**.

### 2. `ChatHost` (main process) — sibling to `PtyHost`

A new `src/chat-host.ts`, structurally parallel to `PtyHost`: one entry per session, owns the
underlying agent process/SDK session, and bridges normalized events ↔ the webview. It is the
**only** place that knows an adapter exists. Responsibilities:

- `start(sessionId, spec)` — instantiate the adapter for the session's protocol, wire its
  `onEvent` to `send({ type: 'chat:event', sessionId, event })`.
- `command(sessionId, cmd)` — forward a `ChatCommand` to the adapter.
- `dispose` / `disposeAll` — tear down the adapter (kill the child / end the SDK query).

### 3. The agent-agnostic core — normalized model

`src/chat-protocol.ts` (pure, no Electron/SDK imports → unit-testable, importable by both host
and webview, like `src/protocol.ts`):

```ts
type ChatEvent =
  | { kind: 'session_started'; model: string; cwd: string; tools: string[];
      availableModes: PermissionMode[]; slashCommands: SlashCommand[] }
  | { kind: 'assistant_text'; delta: string }          // streamed
  | { kind: 'thinking'; delta: string }                // reasoning, optional
  | { kind: 'tool_call'; id: string; name: string; title: string; input: unknown }
  | { kind: 'tool_result'; id: string; ok: boolean; output: string }
  | { kind: 'permission_request'; id: string; toolName: string; input: unknown;
      suggestions?: PermissionSuggestion[] }
  | { kind: 'plan_update'; steps: PlanStep[] }          // read-only in v1
  | { kind: 'mode_changed'; mode: PermissionMode }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string } // e.g. classifier block
  | { kind: 'turn_complete'; usage?: TokenUsage; stopReason?: string }
  | { kind: 'error'; message: string };

type ChatCommand =
  | { kind: 'user_message'; text: string }
  | { kind: 'permission_decision'; id: string; behavior: 'allow' | 'deny' | 'always';
      updatedInput?: unknown; reason?: string }
  | { kind: 'set_mode'; mode: PermissionMode }
  | { kind: 'slash_command'; name: string; args?: string } // sugar → user_message '/name args'
  | { kind: 'interrupt' };

type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';
```

The **adapter interface**:

```ts
interface ChatAdapter {
  start(opts: { cwd: string; mode: PermissionMode; resumeId?: string }): Promise<void>;
  send(cmd: ChatCommand): void;
  onEvent(cb: (e: ChatEvent) => void): void;
  dispose(): void;
}
```

v1 ships **`ClaudeCodeAdapter`** + **`FakeAdapter`** (deterministic scripted events for tests,
no network). `CodexAdapter` is a later module implementing the same interface — its only job is
to translate `codex exec --json` JSONL ↔ the union above.

### 4. `ClaudeCodeAdapter` — uses the Agent SDK streaming session

Uses `@anthropic-ai/claude-agent-sdk` `query()` in **streaming (persistent) mode**, NOT
one-shot `-p`. This is **load-bearing**, not convenience:

- A persistent streaming session keeps context alive across turns and exposes
  `canUseTool` and mid-session `setPermissionMode`.
- The docs warn that in one-shot non-interactive `-p`, **Auto mode aborts the session on
  repeated classifier blocks** (no human to prompt). A streaming session lets us route that
  fallback to our inline-approval card instead of dying.

Mapping:

- SDK assistant message text → `assistant_text` deltas; thinking blocks → `thinking`.
- SDK tool-use blocks → `tool_call`; tool results → `tool_result`.
- `canUseTool(toolName, input)` callback → emit `permission_request`, **return a Promise**
  that resolves when the matching `permission_decision` command arrives (`allow` →
  `{ behavior: 'allow', updatedInput }`, `deny` → `{ behavior: 'deny', message }`).
- `set_mode` → `query.setPermissionMode(mode)` → emit `mode_changed`.
- `system/init` → `session_started` (model, tools, available modes, slash commands).
- `interrupt` → SDK interrupt.
- Classifier block notices (Auto mode) → `notice` events.

**Do NOT pass `--bare`.** Bare mode is recommended for CI but skips skills, CLAUDE.md, MCP,
and hooks — we deliberately load full context so skills are available and `system/init`
reports them for the picker.

**`claude` not on PATH / SDK launch failure** → emit `error`; ChatPane renders a friendly
"couldn't start agent" card with the message (the chat analogue of the red spawn-failure text
in `pty-host.ts:103`).

### 5. Running modes — selector + Auto-mode handling

The selector exposes four primary modes plus a gated one:

| UI label | `PermissionMode` | Behaviour |
|----------|------------------|-----------|
| Plan | `plan` | Research only; proposes a plan, no edits |
| Default | `default` | Reads auto; risky tools → **inline approval card** |
| Accept edits | `acceptEdits` | File edits + common fs commands auto; others prompt |
| Auto | `auto` | Server-side **safety classifier** decides per action |
| Bypass (opt-in) | `bypassPermissions` | No checks; hidden behind an explicit opt-in toggle |

**Auto mode** (the classifier the user called out): a separate server-side classifier model
reviews each tool call. Decision order: allow/deny rules → reads + working-dir edits
auto-approved → everything else to the classifier. It **allows** local file ops,
lockfile-declared dep installs, read-only HTTP, pushing to your own branch; it **blocks**
`curl|bash`, data exfiltration, prod deploys/migrations, mass cloud deletion,
force-push/push-to-`main`, etc. On a block it **redirects Claude to try another approach**
(surfaced as a `notice`), and a repeated-block fallback routes to the inline approval card.
Auto also honors **conversational boundaries** ("don't push").

**Availability gating is mandatory.** Auto mode requires specific models (Opus 4.6+/Sonnet
4.6) and account/provider eligibility. The selector reads `availableModes` from
`session_started`; if `auto` is absent it is shown **disabled with a tooltip** ("requires a
supported model/plan") — never a dead option. Default starting mode = `default` (or the user's
configured `defaultMode`); not Auto.

Because the Auto classifier is server-side, our **inline approvals are primarily for
`default` / `acceptEdits`**; in `auto` the chat mostly shows classifier redirect/block
`notice`s plus the eventual fallback prompt.

### 6. IPC

Mirror the existing `term:*` shape in `src/protocol.ts`:

- host → webview: `{ type: 'chat:event'; sessionId; event: ChatEvent }`
- webview → host: `{ type: 'chat:command'; sessionId; command: ChatCommand }`,
  `{ type: 'chat:start'; sessionId }`, `{ type: 'chat:dispose'; sessionId }`

### 7. `ChatPane` (renderer) — the clean, elegant UI

A new `webview/components/chat-pane.tsx` rendered for chat sessions (where `TerminalPane`
would be). Reduces the `chat:event` stream into a message-list view model.

**Message list:**

- **User** bubbles.
- **Assistant** markdown — **reuse the existing markdown viewer** (`markdown-viewer.tsx`,
  incl. the W4 mermaid + image work) so code blocks, links, and diagrams render consistently.
- **Thinking** — collapsible, dimmed, collapsed by default.
- **Tool-call cards** — collapsible, titled by tool (`Bash`, `Edit`, `Read`, …):
  - **Edits** → render a **diff** via the existing diff viewer.
  - **Bash** → syntax-highlighted command + output.
  - **File paths** in inputs/outputs are **clickable → open in Monaco** (reuse
    `readFile`→`fileContent` + the reveal seam), sharing the detection from the
    `terminal-path-links` spec (D11) where practical.
  - status chip: running / ok / error.
- **Permission cards** — inline **Allow / Deny / Always-allow** (Always → session allowlist,
  optionally persisted per agent). Acting on the card sends `permission_decision`.
- **Plan** — `plan_update` renders a read-only checklist (the interactive-buttons upgrade is
  the deferred seam, §10).
- **Notices** — info/warn/error chips (classifier blocks, retries, mode changes).

**Composer:**

- Multiline textarea + send.
- **Running-mode selector** (§5).
- **Slash-command / skills picker**: typing `/` opens a menu populated from
  `session_started.slashCommands`; selecting injects `/name` as the next user turn
  (user-invoked skills/commands work in `-p` mode by including `/name` in the prompt string).
- **Interrupt** (Esc / button) while a turn runs → `interrupt`.

**Attention integration (serves [[conduit-daily-driver-goal]]):** a running turn drives the
existing **busy indicator**; a `permission_request` drives the existing **needs-attention**
seam (flashFrame / overlay / badge) so the user is pulled back exactly when the agent is
blocked on them.

**Mock-preview guard:** like the rest of the renderer, ChatPane must tolerate
`window.agentDeck` being absent — the fake shell emits no chat events, so the pane shows an
empty/placeholder state rather than throwing.

### 8. Persistence / resume

A chat session's value is its transcript. Persist, in userData alongside `sessions.json`
(not the repo):

- the **normalized transcript** (bounded ring of `ChatEvent`s or a compacted view model), and
- the **underlying CLI session id** (captured from `session_started`).

On reopen / app relaunch: restore the transcript into the message list and **resume the agent
via `--resume <cliSessionId>`** so context continues, with a visible **restored-boundary
marker**. This is the chat analogue of T2 scrollback and reinforces the T1B durability work.
If resume fails (session expired), keep the transcript visible and start a fresh underlying
session with a notice.

### 9. Files / editor integration

- Tool-call file paths → open in Monaco / reveal (§7).
- File-mutating tools (Edit/Write) → trigger the existing **explorer refresh** seam so the
  Files tree (and git decorations, once D13 lands) update.
- Inline diffs reuse the existing diff viewer — no new diff engine.

### 10. Interactive-planning seam (designed, not built)

The model already carries `plan_update` (rendered read-only in v1). The future upgrade adds:

```ts
| { kind: 'interactive_prompt'; id: string; question: string; options: PromptOption[] }
// command: { kind: 'prompt_response'; id: string; optionId: string }
```

ChatPane would render `interactive_prompt` as **collapsible option buttons**; a pick sends
`prompt_response`. Codex plan updates and Claude Code `ExitPlanMode` / `AskUserQuestion` map
onto this seam. **v1 implements only the read-only half**; the event/command names are
reserved now so the later phase is additive.

## Decisions

- **SDK over raw-CLI-spawn for Claude Code.** The SDK runs the same CLI underneath but gives
  `canUseTool`, mid-session `setPermissionMode`, typed messages, and `--resume` — and a
  persistent streaming session avoids the one-shot `-p` Auto-mode abort. `clui-cc` spawns the
  raw CLI + a localhost permission-hook server; the SDK gives us the same interception without
  running an HTTP server in-process.
- **Protocol on the agent definition**, not a hard-coded name list — keeps it agent-agnostic
  and lets unknown CLIs default to a terminal.
- **`FakeAdapter` is part of the abstraction, not an afterthought** — it makes CI deterministic
  and offline (no API key, no network) and is the only way to smoke-test the chat UI.
- **Don't use `--bare`** — we want skills/CLAUDE.md/MCP loaded and surfaced.
- **Reuse, don't rebuild** — markdown/mermaid/image viewer (W4), diff viewer, path-link
  detection (D11), busy + attention seams, explorer refresh.
- **Codex is designed, not built** — the abstraction is proven with one real adapter first.

## Testing

- **Unit (vitest, pure):**
  - Event normalizer per adapter: SDK message fixtures → `ChatEvent[]` (and later Codex JSONL
    fixtures → the same union).
  - Mode mapping (UI label ↔ `PermissionMode`) and availability gating (hide/disable `auto`).
  - Permission reducer: `permission_request` + `permission_decision` → resolved `canUseTool`
    result; `always` updates the allowlist.
  - Transcript persistence round-trip (serialize → restore → same view model).
  - ChatPane reducer: event stream → message-list view model (ordering, streaming-delta
    coalescing, tool_call/result pairing).
- **Real-app smoke (W1 harness, `test/e2e/`):** new `chat.e2e.mjs` driven by **`FakeAdapter`**
  (no real API): (1) a scripted turn renders user + assistant markdown; (2) a `tool_call`
  renders a collapsible card; (3) a `permission_request` renders a card and **Allow** resolves
  it and the turn continues; (4) switching mode emits `set_mode` and the selector reflects
  `mode_changed`; (5) a `plan_update` renders the read-only checklist. The adapter is selected
  via an env/flag seam so the smoke run never touches the network.

## Acceptance criteria

- [ ] An agent with `protocol: 'claude-code'` opens as a **chat**, not a terminal; `shell`
      and protocol-less agents still open as terminals.
- [ ] A real Claude Code turn renders streamed assistant markdown, collapsible thinking, and
      rich tool-call cards (edits as diffs, Bash with output, clickable file paths).
- [ ] In `default`/`acceptEdits`, a risky tool shows an inline Allow/Deny/Always card and the
      decision is honored; `always` stops re-prompting that tool for the session.
- [ ] The mode selector switches Plan/Default/Accept-edits/Auto mid-session; **Auto is
      disabled with a tooltip** when the model/account doesn't support it.
- [ ] Typing `/` lists available skills/commands; selecting one runs it.
- [ ] A running turn drives the busy indicator; a permission request drives needs-attention.
- [ ] Closing and reopening a chat session **restores the transcript** and resumes context via
      `--resume` (with a restored marker); resume failure degrades gracefully.
- [ ] `plan_update` renders read-only; `interactive_prompt`/`prompt_response` names reserved.
- [ ] `FakeAdapter` smoke scenario passes with **no network**; `ChatAdapter`/normalizer units
      pass.
- [ ] `npm run verify` exits 0 and `node esbuild.mjs` is green (SDK is main-process only; no
      new renderer bundle risk).

## Out of scope

- **Codex adapter** — designed (implements `ChatAdapter`); not built here.
- **Interactive option-button picking** — seam reserved (§10); only `plan_update` read-only
  ships.
- **Voice input** (`clui-cc` has it) — YAGNI.
- **Skills marketplace / install** — we only surface and invoke *existing* skills.
- **Multi-agent orchestration inside one chat** — one chat = one agent session.
- **Bypass-permissions as a default** — available only behind an explicit opt-in toggle.

## References

- `src/pty-host.ts` — `PtyHost` (the structural model for `ChatHost`); spawn-failure surface
  (`:103`); `resolveLaunchSpec` (`:165`).
- `src/agent-registry.ts`, `src/types.ts` (`AgentDefinition`) — gains `protocol?`.
- `src/protocol.ts` — add `chat:event` / `chat:command` / `chat:start` / `chat:dispose`.
- `webview/components/markdown-viewer.tsx` — reused for assistant markdown (W4 mermaid/image).
- `terminal-path-links` spec (D11) — shared file-path detection / open-in-editor seam.
- Smoke harness (W1) — hosts `chat.e2e.mjs`; `FakeAdapter` keeps it offline.
- Reference impl: [`clui-cc`](https://github.com/lcoutodemos/clui-cc) — Electron/React/Zustand
  `claude -p --output-format stream-json` wrapper with a permission-hook server.
- Claude Code docs (verified 2026-06-17): [headless](https://code.claude.com/docs/en/headless),
  [permission modes](https://code.claude.com/docs/en/permission-modes),
  [auto mode](https://claude.com/blog/auto-mode).
- Codex docs: [non-interactive](https://developers.openai.com/codex/noninteractive),
  [app-server](https://developers.openai.com/codex/app-server),
  [SDK](https://developers.openai.com/codex/sdk).
