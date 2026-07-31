# Revamp design references — frame index

Source: `Conduit Revamp.zip` (Claude Design handoff, 2026-07-31). The `.dc.html` design docs
were rendered frame-by-frame at their native 1320×820 (Settings is 1320×1060).

- `spec/00-README.md` — the handoff README: themes, shell geometry, chamfer rule, status system,
  theme↔font coupling, registry edits, files to touch, open questions.
- `spec/Conduit Token Contract.txt` — **the contract**. Every token, three themes side by side,
  density rules, `themes.ts` diffs, migration. Read this before touching `styles.css`.
- `spec/Conduit Design Language.txt` — the source shell (5a–5f, 6a–6c) with per-frame notes.
- `spec/Conduit <screen>.txt` — per-screen notes.

| Frame | Screen |
|---|---|
| `design-language-01/02/03` | **6a / 6b / 6c** — Aero Dark: workspace · review changes · parts |
| `design-language-04/05/06` | **5a / 5b / 5c** — Aero (light): workspace · review changes · parts |
| `design-language-07/08/09` | **5d / 5e / 5f** — Neon: workspace · review changes · parts |
| `empty-state-01/02` | **8a** — empty state, Aero · Neon |
| `code-editor-01/02` | **8b** — code editor, Aero · Neon |
| `changes-panel-01/02` | **8c** — Changes rail, Aero · Neon |
| `settings-appearance-01/02` | **8d** — Settings › Appearance, Aero · Neon |
| `feature-board-01/02` | **8e** — feature board, Aero · Neon |
| `architecture-canvas-01/02` | **8f** — architecture canvas, Aero · Neon |
| `overlays-01/02` | **8g** — new-session modal, Aero · Neon |
| `overlays-03/04` | **8h** — session context menu, Aero · Neon |

The frames are **references, not code**: they were prototyped with inline styles. Every value
lands as a CSS custom property under `[data-theme]` / `[data-density]` per the token contract.
