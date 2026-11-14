# Design round: Conduit's surface system · UX · 3 directions

**Target.** How Conduit shows things across the whole app. Where a decision appears, where a
state or problem appears, where the result of your own action appears, where a focused task
happens (starting a session, answering a question), and where long work happens. Today this
has grown into many one-off surfaces: a floating stack (approval card, update card, toasts),
about 15 dialogs, centre banners, a server banner, in-terminal cards, a request pop-up and
a request tab. The owner wants a small, consistent set of patterns, each with one job, that
every screen uses. Your direction (in your own brief) says which set and how they work.

## Read
- `docs/UX.md`: all of it, especially §2 users, §3 interfaces (voice dictation and pointer
  first; keyboard secondary), §4 register, §5 places, §6 flows, §8 words, §9 rules.
- The product, read-only, for real names, data and copy: `webview/components/` (top-bar,
  sidebar, center-pane, right-pane, status-bar, toasts, approval-card, server-banner,
  new-session-modal, settings-modal), `webview/*-strings.ts`.
- The kit: `docs/design/kit/wireframe.css`, `docs/design/kit/frame.html`.

## Do not read
`docs/design-handoff/`, `docs/specs/`, `docs/plans/`, the other designers' folders in this
round, `/home/namemenima/projects/.wt/`, and git history for design work.

## Draw: 4 moments, the same for every designer
Each is a full 1440×900 window with real content (sessions such as "Three-process lead"
claude-3, "app lane" codex-4, "api-server" codex-6, spaces Conduit and Nimbus), never
placeholder text.
1. **Things arrive while you work.** You're dictating into claude-3's terminal. At the same
   moment: codex-4 asks you to choose between two options (A/B, with a short reason each);
   claude-3 wants approval to run `npm run e2e:remote -- --full`; a timed message you
   scheduled was just sent to api-server; an update is ready to install. Show how each
   reaches you, and that nothing steals focus from the terminal.
2. **Answering.** You act on codex-4's A/B question and answer it, with the option to say
   something else in your own words.
3. **A focused task that isn't a request.** Starting a new session: pick the agent CLI
   (Claude Code, Codex, OpenCode, a shell…), the folder(s) and an optional role brief.
4. **Something is wrong.** The background service restarted. Terminals reconnect, and
   codex-6's launch failed (Retry / Discard). Show where each problem appears and how you fix it.

## Rules for drawing
- Copy `docs/design/rounds/2026-11-14-surfaces-ux/frame.html` into your folder for every
  screen, and change its stylesheet link to `../../../kit/wireframe.css`.
- **Free regions:** topbar, center, sidepanel, statusbar. You may also add overlay elements
  inside `.wf-frame` (after the status bar) using `wf-overlay`, `wf-scrim` and absolute
  positioning. The **sidebar** is locked and must stay byte-identical.
- Use only `wireframe.css` classes (`wf-*`, `is-*`). Inline styles for layout only. No
  `<style>`, other CSS, fonts, images or SVG.
- `python3 docs/design/tools/kit-lint.py --frame docs/design/rounds/2026-11-14-surfaces-ux/frame.html <your screens>`
  must pass.
- The pattern set is the point. Name your patterns in a small legend: one `wf-note` per
  screen at most, naming which pattern each visible surface is. Notes are hidden in clean
  shots with `body.wf-clean`.

## Deliver to `docs/design/rounds/2026-11-14-surfaces-ux/d<n>-<short-name>/`
- `screen-1.html` … `screen-4.html`
- `shots/screen-1.png` … `screen-4.png` at 1440×900, clean: add `wf-clean` to body for the
  shot, or shoot a copy with it
- `README.md`, at most 15 lines:
  - your pattern set as a short table (pattern → its one job)
  - one line per screen
  - any decision the owner should know about

## Check before finishing
Render every screen headless and look at each image. Fix unreadable, overlapping or clipped
text.
- Serve with `python3 -m http.server <your port> --bind 127.0.0.1` from the repo's `docs/`
  folder. Note its PID and stop only that PID afterwards.
- Use `playwright-cli -s=<your session name> …` (headless by default). Resize to 1440 900,
  screenshot, and close the session.
- **Apps tested on this machine stay hidden.** Never open a visible browser window, never
  launch the Conduit app, and never kill processes by name.
- Don't commit and don't touch git.
