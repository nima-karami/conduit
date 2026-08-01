# Conductor decisions

Architecture and taste calls made without a human in the loop. Each records what the design asked
for, what we're doing, and why — so the user can overturn any of them cheaply.

## D1 · Review file list stays inside the Review document

**Design (5b/5e):** the left rail becomes the review file list while reviewing — it occupies the
Sessions panel's slot.
**Decision:** build the file list as a full-height left column **inside** the Review doc; the
Sessions rail stays put.
**Why:** the product's premise is several agents running at once. Hijacking the sessions rail
blinds you to the other three agents exactly when you're heads-down in a diff, which fights §7.3
(status too quiet). Visually it lands in the same place when the sessions rail is collapsed.

## D2 · Theme ids and migration

Ids are `aero`, `aero-dark`, `neon` (the contract's prose says "aero-light" once; the registry diff
says `aero`, which wins). Stored settings migrate: `midnight | slate | nord | forest → aero-dark`,
`paper → aero`, `contrast → aero-dark`. Same for `iconPack`, which becomes a per-theme default
(`colored` for Aero, `minimal` for Neon) — applied on migration only, never overriding a user's
later pick.

## D3 · The theme ground and the animated background coexist

The theme owns the **ground** (Aero's two-radial tint, Neon's near-black + scanline/sweep, gated by
`--theatre`). The existing `background` setting (`none | aurora | mesh | grid | flow | shader`) and
`bgIntensity` keep driving the animated backdrop layer **on top of** the ground. The design's
Settings frame shows "Gradient"/"Shader" — treated as the existing options, not a rename.

## D4 · One `styles.css`, disjoint selector namespaces

No split into partials mid-refactor. Lanes own disjoint selector namespaces and disjoint component
files; merges are serial with a full verify after each. Splitting a 9k-line stylesheet while eight
lanes edit it is how you get a merge that typechecks and looks broken.

## D5 · The Neon chamfer is CSS, not DOM

`clip-path` cuts the border box, so a notched surface loses its border along the diagonal. The
foundation lane provides the mechanism once — `--notch` plus a `::after` diagonal in the surface's
own border colour — applied by selector list under `[data-theme="neon"]`, with a `.chamfer`
utility class for stragglers. Components do not each grow a `<span>`.

## D6 · Card subtitles come from a new host-provided `lastLine`

The designs put a live line under every session name ("Edit webview/styles.css", "Apply edit to
router.ts? (y/n)"). Nothing in the renderer can see another session's output today. The host gains
`session.lastLine`: the last non-empty line of that session's PTY ring, ANSI-stripped, trimmed to
120 chars, recomputed on the existing coalesced state broadcast. One mechanism serves every state's
subtitle.

## D7 · The busy meter is indeterminate — no invented numbers

The frames show a progress bar and a `62` counter for a busy agent. No such signal exists (there's
no progress protocol with a CLI agent). We ship an **indeterminate activity meter**; the numeric
readout is dropped. Faking a percentage would be lying in the UI.

## D8 · "Reopen last" ships

`repos.json` already stores `lastOpened` + `lastAgentId` per folder, so the empty state's third
route is real. All three routes ship.

## D9 · Per-file reviewed state is per-open-document

Reviewed checkboxes and the `3 / 6 reviewed` meter live in the open Review document's state; they
reset when the tab closes. Persisting them needs a new keyed store (repo × source × path) and is
out of scope for this run.

## D10 · Accept all / Discard map to real git actions

Working-tree review: **Accept all** stages every changed file; **Discard** discards all working-tree
changes behind the existing confirm dialog (destructive, so it uses `--bad` and asks). For a commit
or range source there is nothing to accept — the footer is hidden rather than shown disabled.

## D17 · The review "narrative" is the commit message, or nothing

5b/5e put a one-line narrative under the Review header: *"Claude merged the git band into the tab
row and rebuilt the session card spine."* Nothing in Conduit can write that sentence — it would
require summarising a diff, which means an LLM call the app does not make and the user did not
authorise.

So: reviewing a **commit or a range**, the line is the commit subject (real, already there).
Reviewing the **working tree**, the line is omitted and the diffstat carries the header alone.
An invented summary is worse than no summary — it would be the one line in the UI that lies.

## D18 · Attention accuracy is out of scope, and the revamp makes it visible

The five-state rail exposes an existing weakness: `needsAttention` fires on a busy→idle edge while
unfocused, so a plain shell that printed a prompt reads as "Needs you". That heuristic predates this
run (the north-star roadmap lists output-driven busy detection as P2). We are **not** fixing it
here — it needs foreground-process detection on the host, which is its own feature with its own
smoke tests. Recorded so the louder cards are understood as surfacing the flaw, not adding it.

## D15 · The "Review" state means *an agent ran and left changes*, not *the repo is dirty*

The frames show a session sitting in a **Review** state with a diffstat (`6 files · +58 −79`).
Deriving that from "the worktree is dirty" would put almost every session in Review permanently,
which makes the state meaningless. Derivation: the session has completed at least one busy→idle
transition **and** its active repo is dirty. So it reads as "this agent finished and produced
something to look at". A session you have merely opened in a dirty repo stays Idle.

## D16 · Snooze silences one session for 10 minutes

"Go to" focuses the session. **Snooze** clears `needsAttention` and suppresses re-raising it for
that session for 10 minutes — the agent is still waiting, you have just said "not now". It must
not kill the prompt or answer it. Renderer-side timer; a new attention edge after the window
expires raises it again.

## D14 · Copy is identical across themes; only case and tracking change

The Neon frames rewrite the words themselves — `QUERY_` for the search placeholder, `FILTER_`,
`/SESSIONS`, `! INPUT` for "Needs you", `JUMP` / `HOLD` for "Go to" / "Snooze", `2 ALERTS` for
"2 need you". We ship **one string set**, with Neon uppercasing it through `--label-case` /
`--label-track`. The handoff's own rule decides this: *"Where the two diverge it is treatment
(case, radius, glow), never structure or behaviour."* Per-theme copy would mean every string
grows a variant, doubling what has to be written, translated and tested, and it would make a
theme switch change what the UI *says* — which is a behaviour change wearing a costume.

## D13 · `--r-window` styles the in-app shell, not the OS window

Aero's floating panels only read correctly "if the Electron window is itself rounded (12px, with a
1px hairline)". True frameless rounding needs `transparent: true`, which on Windows disables GPU
paths the shader background depends on and is a risky main-process change to make mid-refactor
(see the GPU switches CLAUDE.md tells us not to remove). So `--r-window` and `--win-hairline`
style the in-app shell backdrop; the OS window keeps its own (Windows 11 already rounds it).
Revisit as a standalone change with its own smoke test.

## D12 · Legacy radii alias to the new shape tokens

`styles.css` uses `--r` / `--r-sm` in hundreds of rules. Rather than hand-editing every one (a
huge diff that would collide with every lane), the foundation aliases them: `--r: var(--r-card)`,
`--r-sm: var(--r-ctl)`. Every existing rule follows the theme's shape the moment F0 lands, and
Neon's zero-radius rule holds globally. Lanes replace specific usages only where the design calls
for a different radius.

## D11 · `_isKnownTheme` migration must not silently default

An unknown stored theme maps through the D2 table; only a genuinely unrecognised value falls back
to `aero-dark`. Every existing install has an invalid theme on first launch after this ships, so a
silent default would reset everyone to the same theme regardless of whether they ran light or dark.

## D19 · An agent-proposed node is the proposal review, not a new flag

8f draws "Plan View" as a dashed amber card and calls it "an agent-proposed component". Conduit
already has that state for real: an agent writes `.conduit/architecture.proposed.json`, the canvas
banners it, and *Review changes* opens the proposed doc as an editable draft with the agent's
additions and edits tagged. Adding a per-node "proposed" field would have been a second, parallel
mechanism that no agent writes and nothing clears.

So the frames' treatment — dashed border, dashed accent bar, the sparkle glyph, a coloured pin —
is applied to the tags the review already computes. The hue stays the review's own legend, which
the handoff itself states (Feature Board notes: *"Proposal opens as an editable draft: green =
added, amber = edited"*): **added is green, edited is amber**, and both wear the dashed treatment
that says "not yet accepted". The one deviation from the frame is that its single proposed card is
amber where ours is green — we have two proposal roles and one drawn example, and inverting the
legend to match one card would have contradicted the sentence rendered directly above the canvas.

## D20 · The canvas breadcrumb stays cased; only labels take `--label-case`

8f's Neon frame reads **ARCHITECTURE** where Aero reads *Architecture*. In the app that line is the
breadcrumb — the root graph's own title, which is the project's or the agent's text, and inside a
nested component it is a component name. D14 uppercases *labels* through `--label-case`; upper-casing
a value the user typed is a different act, and it would make the same string render two ways
depending on theme. The toolbar and every real label around it still case with the theme.
