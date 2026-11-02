REVISE — the split is workable, but three producer/consumer seams need settling before the lanes build.

Reviewed revision 9 of ADR 0007, the architecture, program, spike, ownership inventory, C1–C7,
the contract tests/fixture, and the existing host/domain/renderer code. This is a pre-build review
of the supplied working tree, not a pinned implementation diff. No gate, runtime mutation, or
hc lifecycle command was run. Round-8 fixes and explicitly accepted residuals are not re-opened.

| Dimension | Assessment |
|---|---|
| Requirements and quality attributes | Yellow: durability is clear; restore-off semantics remain unspecified. |
| Boundaries | Red: windowless close and repo auto-follow cross boundaries without usable seams. |
| Pattern restraint | Green: the ring, screen model and supervisor each have a stated reason. |
| Data and state | Red: the MCP open outcome cannot carry the required recovery result. |
| Change tolerance | Yellow: file compatibility covers only part of the server's persisted state. |
| Failure realism | Yellow: uninstall's fallback can preempt a healthy stopping transition. |
| Decision capture | Green: the split, hc reuse and local-only trade-offs are explicit. |

## Blockers

**B1 — blocker: changing the gate does not make `close_session` windowless.**
Anchor: architecture F3/D8; program W0b/W5; `src/conduit-mcp/app-control-tools.ts:180–206`;
`src/contracts/server-ports.ts:42–63` (`DomainPort`).
The imported close handler calls `routeWindow` during preparation and again during execution,
then asks the renderer to close the session and check dirty buffers. C7 supplies no server-local
close operation. W0b names only the gate split; W5 must import these shared modules unchanged.
Consequently policy `on` still fails with `window_not_ready` when the app is gone. This also breaks
F3's recovery instruction to close an unconfirmed session before opening a replacement.
Direction: add an explicit domain close seam and assign the shared-handler change before W5.
Keep the dirty-buffer check when a ready owner exists; specify the no-window behavior separately.
Cover both windowless close and refusal for dirty documents with a window present.

**B2 — blocker: the W4→W5 open contract cannot express launch uncertainty or stopping.**
Anchor: architecture F3 (line 302); `src/contracts/server-ports.ts:50`;
`src/conduit-mcp/control-tools.ts:47–49,410–423`; `src/conduit-mcp/types.ts:12–59`.
`DomainPort.openSession` inherits `McpOpenOutcome`, whose only failure codes are `unknown_agent`
and `brief_unavailable`. `ToolErrorCode` has neither `spawn_unconfirmed` nor `server_stopping`,
and `ToolError` has no structured session id. The existing handler maps a thrown error to
`open_failed`, losing the recovery state. Thus W4 cannot return the required result to the
unchanged W5 consumer, and the caller cannot reliably identify the session it must close.
Direction: freeze the MCP-facing failure payload, including the session id for an unconfirmed
launch, and update the shared outcome, error mapping and tests in a lead-owned prerequisite.
Distinguish the C2 RPC error channel from MCP's tool-result envelope.

**B3 — blocker: repo detection and auto-follow are assigned to different copies of session state.**
Anchor: architecture internal-subscriber rows at lines 424/428; program W4/W7;
`electron/main.ts:1373,1527,3837–3849`; `src/contracts/server-protocol.ts` (`SessionMutation`).
W7 owns repo scans and `repo:*`; W4 is explicitly told to retain `setAutoRepo` on foreground cwd.
Today `setAutoRepo` needs the detected `s.repos`, manual pin and editor-context state held by the
same SessionManager. C2 carries none of those app→server updates. The server therefore cannot
perform its assigned sub-repo follow; independently decorating the app's session copy also needs
a merge rule so each `sessions.changed` does not replace its repo fields.
Direction: keep repo detection, pinning, context and active-repo derivation together in the app,
consume the server's cwd there, and define the app-local overlay when merging session snapshots.
Alternatively specify the missing C2 producer/consumer pair; do not leave the lanes to choose.

## Should-fix

**S1 — should-fix: folder-health ownership drops the watch-suspect input.**
Anchor: architecture line 427; `electron/session-folder-runtime.ts:176–189`;
`electron/project-watcher.ts:123–124,137–141`; `src/folder-health.ts:222–239`.
Health moves to W4 and watches stay in W7, but the listed health inputs are session operations
and presence focus. Today's watch loss/rename invokes `suspect` to mark a previously healthy
folder missing. The health poll only checks folders already marked missing; it cannot replace
that signal. Deleting a shown folder while focus stays put loses the immediate health update.
Direction: carry the app's suspect-folder signal to a server recheck through a named C2 method,
and assign both ends. The server should revalidate paths against the session's own folders.

**S2 — should-fix: define `restoreSessions: false` for a durable server.**
Anchor: architecture F1.4.3–5/D7; program W4's persistence move;
`electron/main.ts:1874,2098–2117`; `src/persistence.ts` (`shouldPersistSessions`).
Today's setting suppresses loading and writing sessions.json. Porting that gate leaves token
rows/live hc terminals after a server restart but no persisted session metadata or launch counter.
Ignoring the gate instead restores stale sessions the user opted out of. The design names the
setting's owner but does not resolve its changed meaning.
Direction: specify that authoritative live records and launch counters are always durable and
recoverable, separately from whether stale sessions are reopened. State the migration behavior
for a restore-off user and cover a server restart with that setting off.

**S3 — should-fix: uninstall gives up before a valid stop can finish.**
Anchor: `src/contracts/server-protocol.ts:51` (`STOP_ALL_ANSWER_TIMEOUT_MS = 5000`),
`src/contracts/terminal-runtime.ts:97` (`LAUNCH_SETTLE_ON_STOP_MS = 10000`); architecture uninstall/F12.
A healthy stop may spend ten seconds settling a launch before persisting and replying. At five
seconds the uninstall client instead starts killing terminals/stopping hc directly, racing the
still-running server and bypassing its normal cleanup. This is distinct from the documented
late-registration residual after a completed stop.
Direction: separate failure to connect from waiting for an accepted stop, or make the reply budget
longer than the complete settling/cleanup budget. Test uninstall with an in-flight launch.

**S4 — should-fix: the persisted-file compatibility inventory is incomplete.**
Anchor: `src/contracts/session-identity.ts:177–184` (`SERVER_FILE_SCHEMA`); architecture D12;
`electron/main.ts:437–448,1700–1708`; `src/timed-messages.ts:475–503`.
The claimed “every file the server writes” guard covers five files, but W4/W5/W6 also own projects,
agents, launchers, timed messages, handles, message-store records and scrollback. Some already have
their own version rules; e.g. a foreign timed-message version becomes an empty set and a later
write replaces it. Those formats cannot be covered by the present `ServerFile` union, and the
program does not state which existing rules are accepted exceptions to “refuse, never overwrite.”
Direction: inventory the actual server-owned formats and map each to its existing version/refusal
rule or an explicit exception. Assign any required shared-reader changes before importing them.

**S5 — should-fix: prerelease ordering is lexical rather than semver ordering.**
Anchor: `src/contracts/server-protocol.ts:231`; architecture cross-version order/F6/D26;
`test/unit/contracts.test.ts` (`order versions by generation, then semver`).
For app `0.52.0-rc.10` and server `0.52.0-rc.2`, the comparator returns `appOlder`; numeric
prerelease identifiers order 10 after 2. A normal RC update can therefore take the downgrade
branch and offer to stop agents instead of restarting the server. The tests cover release versus
prerelease but no two prereleases.
Direction: use a semver comparator, or compare dot-separated prerelease identifiers by semver's
numeric/text rules, with RC ordering cases. This fixes the stated ordering rule, not the split.

## Nits

None.

## Simplification

- B3's app-local repo overlay removes the need for repo-state RPCs and a second active-repo model.
- Reuse existing persisted-format version fields for S4 where possible; avoid parallel `version`
  and `schema` mechanisms for the same format.
- Keep hc `foreground` adoption behind M27 as planned; do not build the fallback scanners unless
  that measurement fails. The reuse audit now adequately explains the retained local machinery.

REVIEW: REVISE
BLOCKERS: 3
FINDINGS: 8
