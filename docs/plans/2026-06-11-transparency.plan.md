# Plan — transparency (C3)

Spec: `docs/specs/transparency.md`. Build order is test-first for the pure settings
pieces, then UI/CSS/Monaco wiring, then runtime proof.

## 1. Settings model (`src/settings.ts`)

- Add to `AppSettings`: `codeBg: string` (hex `#rrggbb`), `codeOpacity: number` (0..1).
- `DEFAULT_SETTINGS`: `codeBg: '#0a0b0e'`, `codeOpacity: 1`.
- Add helper `hexColor(v, def)`: returns `v` if it matches `/^#[0-9a-f]{6}$/i`, else
  `def`.
- `restoreSettings`:
  - change `surfaceOpacity` clamp min `0.4 → 0`: `clampNum(raw.surfaceOpacity, 0, 1, …)`.
  - add `codeBg: hexColor(raw.codeBg, DEFAULT.codeBg)`.
  - add `codeOpacity: clampNum(raw.codeOpacity, 0, 1, DEFAULT.codeOpacity)`.

## 2. Tests first (`test/unit/settings.test.ts`)

New `describe` cases:
- panel opacity full range: `surfaceOpacity: 0` survives (was clamped to 0.4);
  negative clamps to 0; `>1` clamps to 1.
- code-block defaults: `DEFAULT_SETTINGS.codeBg === '#0a0b0e'`, `codeOpacity === 1`.
- back-compat: blob missing `codeBg`/`codeOpacity` → defaults.
- `codeBg` validation: valid hex round-trips; `'red'`, `'#fff'`, number → default.
- `codeOpacity` clamp: `-1 → 0`, `2 → 1`, `'x' → 1` (default).
- round-trip: full object with custom code fields preserved.

Run `npx vitest run test/unit/settings.test.ts` red → green.

## 3. Apply to DOM (`webview/settings.tsx`)

In `applyToDom`, after `--surface-alpha`:
- `el.style.setProperty('--code-bg', s.codeBg);`
- `el.style.setProperty('--code-alpha', String(s.codeOpacity));`

## 4. CSS (`webview/styles.css`)

- In the `:root` surface block (~line 2127): add
  `--code-bg: #0a0b0e; --code-alpha: 1;`
  `--code-surface: color-mix(in srgb, var(--code-bg) calc(var(--code-alpha) * 100%), transparent);`
- `.codeblock` (line ~1178): `background: var(--code-surface);`
- `.markdown pre` (line ~1629): `background: var(--code-surface);`

## 5. Monaco editor surface (`webview/monaco-theme.ts`) — v1 translucency

- Add a local `withAlpha(hex, a)` (copy of the xterm-theme helper; small, keeps the
  two themes decoupled) OR read `--code-bg`/`--code-alpha` and build the rgba.
- `const codeBg = v(cs, '--code-bg', '#0a0b0e'); const a = Number(v(cs,'--code-alpha','1'))||1;`
- `const bg = withAlpha(codeBg, a);`
- Set `editor.background` and `editorGutter.background` to `bg`.
- Editor container: make the code viewer surface not paint an opaque panel behind the
  canvas when translucent. In `styles.css`, the `.center`/viewer composites over
  `--surface`. To let editor translucency reach the backdrop, set `.viewer__monaco`
  (or `.viewer`) `background: transparent`. Confirm `.center` still paints surface for
  the empty/terminal states only — code viewer should be transparent so Monaco's own
  bg shows. Keep it minimal: add `.viewer { background: transparent; }` if needed.
- Re-apply theme on settings change: `ensureTheme()` is called at editor mount; code
  fields changing won't re-run it for an already-open editor. Acceptable for MVP — note
  it (editor picks up new code bg on next open / theme change). `.markdown pre` updates
  live via CSS var. If cheap, add a settings-effect to re-call `monaco.editor.setTheme`
  — but only if it doesn't add risk.

## 6. Settings UI (`webview/components/settings-modal.tsx`)

In `Appearance`, after the Surface-opacity/blur cluster (outside the
`background !== 'none'` block so it's always visible — code styling is backdrop-independent):
- Change existing Surface-opacity `Slider min={40}` → `min={0}`.
- New `Section title="Code block background"`: a `<input type="color">` bound to
  `settings.codeBg` → `update({ codeBg })`.
- New `Section title="Code block opacity"`: `Slider min={0} max={100}` value
  `Math.round(settings.codeOpacity*100)` → `update({ codeOpacity: n/100 })`.

NOTE: Surface-opacity slider currently sits *inside* the `background !== 'none'` block.
Moving its min to 0 is enough for the panel requirement. The code-block controls go
*outside* that block so they show even with background 'none'.

## 7. Gates + runtime

- `npm run verify` and `npm run build` → `.autoloop/evidence/transparency-verify.log`.
- Build webview, serve over HTTP, Playwright: open Settings, confirm panel slider min 0;
  confirm code-block colour + opacity controls; open a markdown file w/ code block,
  change code bg, observe change. Screenshots to `%TEMP%\claude-scratch\`. Notes →
  `.autoloop/evidence/transparency-runtime.txt`.

## 8. Review + verify-before-completion

`superpowers:requesting-code-review`, address blocking; `verification-before-completion`.
